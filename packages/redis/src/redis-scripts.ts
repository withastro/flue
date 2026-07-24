const guard = `
local function type_ok(key, expected)
  local actual = redis.call('TYPE', key).ok
  return actual == 'none' or actual == expected
end
local function require_type(key, expected)
  if not type_ok(key, expected) then error('WRONGTYPE ' .. key) end
end
`;

// Joined-delivery settle fan-out, shared by the host settle paths
// (lifecycleScript 'settle' and finalizeSettlementScript). Join row hashes
// occupy KEYS[8..] with their submission ids at the SAME ARGV index, so both
// callers pad to exactly seven fixed keys and seven fixed arguments. 'joined'
// rows settle with the host's outcome (error kept empty on success); 'joining'
// stragglers — a join whose canonical input was never confirmed (abort or
// crash window) — revert to 'queued' so the delivery runs as its own
// submission instead of vanishing. `joinedInto` stays on settled rows for
// inspection.
const joinFanOut = `
local function settle_joins(hostId, settledAt, err, queuedKey, joiningKey, joinedKey, settledKey, unsettledKey)
  for i = 8, #KEYS do
    local key = KEYS[i]
    local id = ARGV[i]
    if redis.call('HGET', key, 'joinedInto') == hostId then
      local status = redis.call('HGET', key, 'status')
      local sequence = redis.call('HGET', key, 'sequence')
      if status == 'joined' then
        redis.call('ZADD', settledKey, sequence, id)
        redis.call('ZREM', joinedKey, id)
        redis.call('ZREM', unsettledKey, id)
        redis.call('HSET', key, 'status', 'settled', 'settledAt', settledAt)
        if err == '' then redis.call('HDEL', key, 'error') else redis.call('HSET', key, 'error', err) end
      elseif status == 'joining' then
        redis.call('ZADD', queuedKey, sequence, id)
        redis.call('ZREM', joiningKey, id)
        redis.call('HSET', key, 'status', 'queued')
        redis.call('HDEL', key, 'joinedInto', 'inputAppliedAt')
      end
    end
  end
end
`;

export const acquireGenerationScript = `${guard}
require_type(KEYS[1], 'hash')
require_type(KEYS[2], 'hash')
if redis.call('EXISTS', KEYS[1]) == 0 then return {} end
local generation = redis.call('HGET', KEYS[1], 'generation')
if not generation then return {} end
local count = redis.call('HINCRBY', KEYS[2], generation, 1)
return {generation, tostring(count)}
`;

export const releaseGenerationScript = `${guard}
require_type(KEYS[1], 'hash')
local count = tonumber(redis.call('HGET', KEYS[1], ARGV[1]) or '0')
if count <= 1 then redis.call('HDEL', KEYS[1], ARGV[1]) return 0 end
return redis.call('HINCRBY', KEYS[1], ARGV[1], -1)
`;

export const reclaimGenerationsScript = `${guard}
require_type(KEYS[1], 'hash')
require_type(KEYS[2], 'hash')
require_type(KEYS[3], 'zset')
local current = redis.call('HGET', KEYS[1], 'generation') or ''
local stale = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])
local removed = {}
for _, generation in ipairs(stale) do
  if generation ~= current and tonumber(redis.call('HGET', KEYS[2], generation) or '0') == 0 then
    redis.call('ZREM', KEYS[3], generation)
    table.insert(removed, generation)
  end
end
return removed
`;

export const admitSubmissionScript = `${guard}
for i = 1, #KEYS do
  if i == 1 or i == 2 then require_type(KEYS[i], 'hash')
  elseif i == 3 then require_type(KEYS[i], 'string')
  else require_type(KEYS[i], 'zset') end
end
if redis.call('EXISTS', KEYS[2]) == 1 then return {'existing'} end
if redis.call('EXISTS', KEYS[1]) == 0 then return {'missing_generation'} end
local sequence = redis.call('INCR', KEYS[3])
redis.call('ZADD', KEYS[4], sequence, ARGV[1])
redis.call('ZADD', KEYS[6], sequence, ARGV[1])
redis.call('HSET', KEYS[2],
  'submissionId', ARGV[1], 'sessionKey', ARGV[2], 'kind', ARGV[3],
  'status', 'queued', 'acceptedAt', ARGV[4], 'sequence', sequence,
  'attemptCount', 0, 'maxAttempts', ARGV[5], 'timeoutAt', 0,
  'leaseExpiresAt', 0, 'generation', ARGV[6])
redis.call('ZADD', KEYS[5], ARGV[7], ARGV[6])
return {'created', tostring(sequence)}
`;

export const markSubmissionCanonicalReadyScript = `${guard}
require_type(KEYS[1], 'hash')
if redis.call('HGET', KEYS[1], 'status') ~= 'queued' then return 0 end
if redis.call('HEXISTS', KEYS[1], 'canonicalReadyAt') == 0 then redis.call('HSET', KEYS[1], 'canonicalReadyAt', ARGV[1]) end
return 1
`;

export const claimSubmissionScript = `${guard}
require_type(KEYS[1], 'hash')
require_type(KEYS[2], 'zset')
require_type(KEYS[3], 'zset')
require_type(KEYS[4], 'zset')
if redis.call('HGET', KEYS[1], 'status') ~= 'queued' then return 0 end
if redis.call('HEXISTS', KEYS[1], 'canonicalReadyAt') == 0 then return 0 end
local sequence = tonumber(redis.call('HGET', KEYS[1], 'sequence'))
if #redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', '(' .. sequence, 'LIMIT', 0, 1) > 0 then return 0 end
redis.call('ZADD', KEYS[4], sequence, ARGV[8])
redis.call('ZREM', KEYS[3], ARGV[8])
redis.call('HSET', KEYS[1], 'status', 'running', 'attemptId', ARGV[2],
  'startedAt', ARGV[3], 'attemptCount', tonumber(redis.call('HGET', KEYS[1], 'attemptCount')) + 1,
  'maxAttempts', ARGV[4], 'ownerId', ARGV[5], 'leaseExpiresAt', ARGV[6])
if redis.call('HGET', KEYS[1], 'timeoutAt') == '0' then redis.call('HSET', KEYS[1], 'timeoutAt', ARGV[7]) end
return 1
`;

export const lifecycleScript = `${guard}${joinFanOut}
require_type(KEYS[1], 'hash')
for i = 2, 7 do require_type(KEYS[i], 'zset') end
for i = 8, #KEYS do require_type(KEYS[i], 'hash') end
if redis.call('HGET', KEYS[1], 'status') ~= ARGV[1] or redis.call('HGET', KEYS[1], 'attemptId') ~= ARGV[2] then return 0 end
local operation = ARGV[3]
if operation == 'input' then
  if redis.call('HEXISTS', KEYS[1], 'inputAppliedAt') == 0 then redis.call('HSET', KEYS[1], 'inputAppliedAt', ARGV[4], 'maxAttempts', ARGV[5], 'timeoutAt', ARGV[6]) end
elseif operation == 'requeue' then
  local sequence = redis.call('HGET', KEYS[1], 'sequence')
  redis.call('ZADD', KEYS[2], sequence, ARGV[7])
  redis.call('ZREM', KEYS[3], ARGV[7])
  redis.call('HSET', KEYS[1], 'status', 'queued', 'leaseExpiresAt', 0)
  redis.call('HDEL', KEYS[1], 'attemptId', 'inputAppliedAt', 'startedAt', 'ownerId')
elseif operation == 'settle' then
  local sequence = redis.call('HGET', KEYS[1], 'sequence')
  redis.call('ZADD', KEYS[4], sequence, ARGV[7])
  redis.call('ZREM', KEYS[3], ARGV[7])
  redis.call('ZREM', KEYS[2], ARGV[7])
  redis.call('ZREM', KEYS[5], ARGV[7])
  redis.call('HSET', KEYS[1], 'status', 'settled', 'settledAt', ARGV[4])
  if ARGV[5] == '' then redis.call('HDEL', KEYS[1], 'error') else redis.call('HSET', KEYS[1], 'error', ARGV[5]) end
  settle_joins(ARGV[7], ARGV[4], ARGV[5], KEYS[2], KEYS[6], KEYS[7], KEYS[4], KEYS[5])
end
return 1
`;

// Claim the contiguous queued prefix for a turn-boundary join. Candidate
// hashes occupy KEYS[4..] in admission order with their submission ids at
// ARGV[i - 1] (three fixed keys, two fixed arguments). The caller pre-vets
// the immutable agent-name predicate; every mutable predicate is rechecked
// here so two concurrent claimers never both claim the same row, and the
// first non-joinable row STOPS the claim (rows behind it stay queued).
export const claimJoinableSubmissionsScript = `${guard}
require_type(KEYS[1], 'hash')
require_type(KEYS[2], 'zset')
require_type(KEYS[3], 'zset')
for i = 4, #KEYS do require_type(KEYS[i], 'hash') end
if redis.call('HGET', KEYS[1], 'status') ~= 'running' or redis.call('HGET', KEYS[1], 'attemptId') ~= ARGV[1] then return {} end
local sessionKey = redis.call('HGET', KEYS[1], 'sessionKey')
local claimed = {}
for i = 4, #KEYS do
  local key = KEYS[i]
  local id = ARGV[i - 1]
  if redis.call('HGET', key, 'status') ~= 'queued' then break end
  if redis.call('HEXISTS', key, 'canonicalReadyAt') == 0 or redis.call('HEXISTS', key, 'abortRequestedAt') == 1 then break end
  if redis.call('HGET', key, 'sessionKey') ~= sessionKey then break end
  local sequence = redis.call('HGET', key, 'sequence')
  redis.call('HSET', key, 'status', 'joining', 'joinedInto', ARGV[2])
  redis.call('ZADD', KEYS[3], sequence, id)
  redis.call('ZREM', KEYS[2], id)
  table.insert(claimed, id)
end
return claimed
`;

export const joinLifecycleScript = `${guard}
require_type(KEYS[1], 'hash')
require_type(KEYS[2], 'hash')
require_type(KEYS[3], 'zset')
require_type(KEYS[4], 'zset')
if redis.call('HGET', KEYS[1], 'status') ~= 'joining' or redis.call('HGET', KEYS[1], 'joinedInto') ~= ARGV[3] then return 0 end
if redis.call('HGET', KEYS[2], 'status') ~= 'running' or redis.call('HGET', KEYS[2], 'attemptId') ~= ARGV[2] then return 0 end
local sequence = redis.call('HGET', KEYS[1], 'sequence')
if ARGV[1] == 'finalize' then
  redis.call('HSET', KEYS[1], 'status', 'joined')
  redis.call('HSETNX', KEYS[1], 'inputAppliedAt', ARGV[4])
else
  redis.call('HSET', KEYS[1], 'status', 'queued')
  redis.call('HDEL', KEYS[1], 'joinedInto', 'inputAppliedAt')
end
redis.call('ZADD', KEYS[4], sequence, ARGV[5])
redis.call('ZREM', KEYS[3], ARGV[5])
return 1
`;

export const replaceAttemptScript = `${guard}
require_type(KEYS[1], 'hash')
if redis.call('HGET', KEYS[1], 'status') ~= 'running' or redis.call('HGET', KEYS[1], 'attemptId') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'attemptId', ARGV[2], 'startedAt', ARGV[3], 'attemptCount', tonumber(redis.call('HGET', KEYS[1], 'attemptCount')) + 1)
if ARGV[4] ~= '' then redis.call('HSET', KEYS[1], 'ownerId', ARGV[4], 'leaseExpiresAt', ARGV[5]) end
return 1
`;

export const renewLeasesScript = `${guard}
for i = 1, #KEYS do
  require_type(KEYS[i], 'hash')
  if redis.call('HGET', KEYS[i], 'status') == 'running' and redis.call('HGET', KEYS[i], 'ownerId') == ARGV[1] then redis.call('HSET', KEYS[i], 'leaseExpiresAt', ARGV[2]) end
end
return 1
`;

// Re-derive every status index from the row hash, the authority. Status and
// sequence are read inside the script, atomically with the zset rewrite — a
// read-then-write repair can lose the race against a peer's transition and
// immortalize the stale status in the indexes. KEYS: row hash, the six
// status zsets in declaration order, session-unsettled (named by the caller
// from the row's immutable sessionKey).
export const repairSubmissionIndexesScript = `${guard}
require_type(KEYS[1], 'hash')
for i = 2, 8 do require_type(KEYS[i], 'zset') end
local row = redis.call('HMGET', KEYS[1], 'submissionId', 'sessionKey', 'status', 'sequence')
if not (row[1] and row[2] and row[3] and row[4]) then return 0 end
local statuses = {'queued', 'running', 'terminalizing', 'settled', 'joining', 'joined'}
for i = 1, 6 do
  if statuses[i] == row[3] then redis.call('ZADD', KEYS[i + 1], row[4], ARGV[1])
  else redis.call('ZREM', KEYS[i + 1], ARGV[1]) end
end
if row[3] == 'settled' then redis.call('ZREM', KEYS[8], ARGV[1])
else redis.call('ZADD', KEYS[8], row[4], ARGV[1]) end
return 1
`;

// Force-settling a corrupt running host must fan its outcome out to joined
// deliveries (KEYS[8..] with ids at the same ARGV index), or they would stay
// gated on the settled host forever and wedge the session queue.
export const quarantineSubmissionScript = `${guard}${joinFanOut}
require_type(KEYS[1], 'hash')
for i = 2, 7 do require_type(KEYS[i], 'zset') end
for i = 8, #KEYS do require_type(KEYS[i], 'hash') end
local sequence = redis.call('HGET', KEYS[1], 'sequence') or ARGV[2]
for i = 2, 6 do redis.call('ZREM', KEYS[i], ARGV[1]) end
redis.call('ZADD', KEYS[7], sequence, ARGV[1])
if redis.call('EXISTS', KEYS[1]) == 1 then redis.call('HSET', KEYS[1], 'status', 'settled', 'settledAt', ARGV[3], 'error', ARGV[4]) end
settle_joins(ARGV[1], ARGV[3], ARGV[4], KEYS[2], KEYS[4], KEYS[5], KEYS[7], KEYS[6])
return 1
`;

// Two reservable shapes: the direct submission's own running attempt
// (attemptId fenced on the row), or a direct delivery JOINED into a host
// that is running under the caller's attempt — KEYS[6] (present only when
// the caller saw a join) is the host hash and ARGV[5] the host id it must
// still match. The joined shape adopts the row on its way to terminalizing
// (attemptId := caller, startedAt set-once) so the terminalizing invariants
// and finalize fencing hold.
export const reserveSettlementScript = `${guard}
require_type(KEYS[1], 'hash')
for i = 2, 5 do require_type(KEYS[i], 'zset') end
if #KEYS >= 6 then require_type(KEYS[6], 'hash') end
if redis.call('HEXISTS', KEYS[1], 'settlementRecordId') == 1 then return 0 end
local status = redis.call('HGET', KEYS[1], 'status')
local running = status == 'running' and redis.call('HGET', KEYS[1], 'attemptId') == ARGV[1] and redis.call('HGET', KEYS[1], 'ownerId') ~= false
local joined = status == 'joined' and #KEYS >= 6 and ARGV[5] ~= '' and redis.call('HGET', KEYS[1], 'joinedInto') == ARGV[5] and redis.call('HGET', KEYS[6], 'status') == 'running' and redis.call('HGET', KEYS[6], 'attemptId') == ARGV[1]
if not (running or joined) then return 0 end
local sequence = redis.call('HGET', KEYS[1], 'sequence')
if running then redis.call('ZREM', KEYS[2], ARGV[2]) else redis.call('ZREM', KEYS[5], ARGV[2]) end
redis.call('ZADD', KEYS[3], sequence, ARGV[2])
redis.call('ZADD', KEYS[4], sequence, ARGV[2])
redis.call('HSET', KEYS[1], 'status', 'terminalizing', 'settlementRecordId', ARGV[3], 'settlementRecord', ARGV[4], 'attemptId', ARGV[1])
redis.call('HSETNX', KEYS[1], 'startedAt', ARGV[6])
return 1
`;

export const finalizeSettlementScript = `${guard}${joinFanOut}
require_type(KEYS[1], 'hash')
for i = 2, 7 do require_type(KEYS[i], 'zset') end
for i = 8, #KEYS do require_type(KEYS[i], 'hash') end
if redis.call('HGET', KEYS[1], 'status') ~= 'terminalizing' or redis.call('HGET', KEYS[1], 'attemptId') ~= ARGV[3] or redis.call('HGET', KEYS[1], 'settlementRecordId') ~= ARGV[4] then return 0 end
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('HSET', KEYS[1], 'status', 'settled', 'settledAt', ARGV[2])
if ARGV[5] == '' then redis.call('HDEL', KEYS[1], 'error') else redis.call('HSET', KEYS[1], 'error', ARGV[5]) end
settle_joins(ARGV[1], ARGV[2], ARGV[5], KEYS[4], KEYS[5], KEYS[6], KEYS[7], KEYS[3])
return 1
`;
