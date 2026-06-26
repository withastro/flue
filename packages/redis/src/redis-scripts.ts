const guard = `
local function type_ok(key, expected)
  local actual = redis.call('TYPE', key).ok
  return actual == 'none' or actual == expected
end
local function require_type(key, expected)
  if not type_ok(key, expected) then error('WRONGTYPE ' .. key) end
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
  if i == 1 or i == 2 or i == 9 then require_type(KEYS[i], 'hash')
  elseif i == 3 then require_type(KEYS[i], 'string')
  elseif i == 8 then require_type(KEYS[i], 'zset')
  elseif i == 4 or i == 5 or i == 6 or i == 7 or i == 10 then require_type(KEYS[i], 'zset') end
end
if redis.call('EXISTS', KEYS[9]) == 1 then return {'receipt', redis.call('HGET', KEYS[9], 'acceptedAt')} end
if redis.call('EXISTS', KEYS[2]) == 1 then return {'existing'} end
if redis.call('EXISTS', KEYS[1]) == 0 then return {'missing_generation'} end
local sequence = redis.call('INCR', KEYS[3])
redis.call('ZADD', KEYS[4], sequence, ARGV[1])
redis.call('ZADD', KEYS[5], sequence, ARGV[1])
redis.call('ZADD', KEYS[6], sequence, ARGV[1])
redis.call('ZADD', KEYS[7], sequence, ARGV[1])
redis.call('ZADD', KEYS[10], sequence, ARGV[1])
redis.call('HSET', KEYS[2],
  'submissionId', ARGV[1], 'sessionKey', ARGV[2], 'kind', ARGV[3],
  'status', 'queued', 'acceptedAt', ARGV[4], 'sequence', sequence,
  'attemptCount', 0, 'maxRetry', ARGV[5], 'timeoutAt', 0,
  'leaseExpiresAt', 0, 'generation', ARGV[6])
redis.call('ZADD', KEYS[8], ARGV[7], ARGV[6])
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
  'maxRetry', ARGV[4], 'ownerId', ARGV[5], 'leaseExpiresAt', ARGV[6])
if redis.call('HGET', KEYS[1], 'timeoutAt') == '0' then redis.call('HSET', KEYS[1], 'timeoutAt', ARGV[7]) end
return 1
`;

export const lifecycleScript = `${guard}
require_type(KEYS[1], 'hash')
for i = 2, 5 do require_type(KEYS[i], 'zset') end
if redis.call('HGET', KEYS[1], 'status') ~= ARGV[1] or redis.call('HGET', KEYS[1], 'attemptId') ~= ARGV[2] then return 0 end
local operation = ARGV[3]
if operation == 'input' then
  if redis.call('HEXISTS', KEYS[1], 'inputAppliedAt') == 0 then redis.call('HSET', KEYS[1], 'inputAppliedAt', ARGV[4], 'maxRetry', ARGV[5], 'timeoutAt', ARGV[6]) end
elseif operation == 'recovery' then
  redis.call('HSETNX', KEYS[1], 'recoveryRequestedAt', ARGV[4])
elseif operation == 'requeue' then
  if redis.call('HEXISTS', KEYS[1], 'inputAppliedAt') == 1 then return 0 end
  local sequence = redis.call('HGET', KEYS[1], 'sequence')
  redis.call('ZADD', KEYS[2], sequence, ARGV[7])
  redis.call('ZREM', KEYS[3], ARGV[7])
  redis.call('HSET', KEYS[1], 'status', 'queued', 'leaseExpiresAt', 0)
  redis.call('HDEL', KEYS[1], 'attemptId', 'recoveryRequestedAt', 'startedAt', 'ownerId')
elseif operation == 'settle' then
  local sequence = redis.call('HGET', KEYS[1], 'sequence')
  redis.call('ZADD', KEYS[4], sequence, ARGV[7])
  redis.call('ZREM', KEYS[3], ARGV[7])
  redis.call('ZREM', KEYS[2], ARGV[7])
  redis.call('ZREM', KEYS[5], ARGV[7])
  redis.call('HSET', KEYS[1], 'status', 'settled', 'settledAt', ARGV[4])
  if ARGV[5] == '' then redis.call('HDEL', KEYS[1], 'error') else redis.call('HSET', KEYS[1], 'error', ARGV[5]) end
end
return 1
`;

export const journalScript = `${guard}
require_type(KEYS[1], 'hash')
if #KEYS > 1 then require_type(KEYS[2], 'set') end
local operation = ARGV[1]
if operation == 'begin' then
  local revision = tonumber(redis.call('HGET', KEYS[1], 'revision') or '0') + 1
  redis.call('SADD', KEYS[2], ARGV[2])
  redis.call('DEL', KEYS[1])
  redis.call('HSET', KEYS[1], 'submissionId', ARGV[2], 'sessionKey', ARGV[3], 'kind', ARGV[4],
    'attemptId', ARGV[5], 'operationId', ARGV[6], 'turnId', ARGV[7], 'phase', ARGV[8],
    'revision', revision, 'createdAt', ARGV[9], 'updatedAt', ARGV[9], 'committed', 0)
  if ARGV[10] ~= '' then redis.call('HSET', KEYS[1], 'checkpointLeafId', ARGV[10]) end
  if ARGV[11] ~= '' then redis.call('HSET', KEYS[1], 'toolRequest', ARGV[11]) end
  return 1
end
if redis.call('HGET', KEYS[1], 'attemptId') ~= ARGV[2] or redis.call('HGET', KEYS[1], 'committed') ~= '0' then return 0 end
local revision = tonumber(redis.call('HGET', KEYS[1], 'revision')) + 1
if operation == 'phase' then
  redis.call('HSET', KEYS[1], 'phase', ARGV[3], 'revision', revision, 'updatedAt', ARGV[4])
  if ARGV[5] ~= '' then redis.call('HSET', KEYS[1], 'checkpointLeafId', ARGV[5]) end
  if ARGV[6] ~= '' then redis.call('HSET', KEYS[1], 'toolRequest', ARGV[6]) end
elseif operation == 'commit' then
  redis.call('HSET', KEYS[1], 'phase', 'committed', 'revision', revision, 'updatedAt', ARGV[3], 'committed', 1, 'committedLeafId', ARGV[4])
end
return 1
`;

export const replaceAttemptScript = `${guard}
require_type(KEYS[1], 'hash')
require_type(KEYS[2], 'hash')
if redis.call('HGET', KEYS[1], 'status') ~= 'running' or redis.call('HGET', KEYS[1], 'attemptId') ~= ARGV[1] then return 0 end
if redis.call('HGET', KEYS[2], 'attemptId') == ARGV[1] and redis.call('HGET', KEYS[2], 'committed') == '0' then
  redis.call('HSET', KEYS[2], 'attemptId', ARGV[2], 'updatedAt', ARGV[3], 'revision', tonumber(redis.call('HGET', KEYS[2], 'revision')) + 1)
end
redis.call('HSET', KEYS[1], 'attemptId', ARGV[2], 'startedAt', ARGV[3], 'attemptCount', tonumber(redis.call('HGET', KEYS[1], 'attemptCount')) + 1)
redis.call('HDEL', KEYS[1], 'recoveryRequestedAt')
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

export const quarantineSubmissionScript = `${guard}
require_type(KEYS[1], 'hash')
for i = 2, 6 do require_type(KEYS[i], 'zset') end
local sequence = redis.call('HGET', KEYS[1], 'sequence') or ARGV[2]
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('ZREM', KEYS[4], ARGV[1])
redis.call('ZREM', KEYS[5], ARGV[1])
redis.call('ZADD', KEYS[6], sequence, ARGV[1])
if redis.call('EXISTS', KEYS[1]) == 1 then redis.call('HSET', KEYS[1], 'status', 'settled', 'settledAt', ARGV[3], 'error', ARGV[4]) end
return 1
`;

export const createRunScript = `${guard}
require_type(KEYS[1], 'hash')
for i = 2, 4 do require_type(KEYS[i], 'zset') end
require_type(KEYS[5], 'set')
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
redis.call('ZADD', KEYS[2], ARGV[5], ARGV[1])
redis.call('ZADD', KEYS[3], ARGV[5], ARGV[1])
redis.call('ZADD', KEYS[4], ARGV[5], ARGV[1])
redis.call('SADD', KEYS[5], 'active')
redis.call('HSET', KEYS[1], 'runId', ARGV[1], 'workflowName', ARGV[2], 'status', 'active', 'startedAt', ARGV[3], 'orderKey', ARGV[6])
if ARGV[4] ~= '' then redis.call('HSET', KEYS[1], 'payload', ARGV[4]) end
if ARGV[7] ~= '' then redis.call('HSET', KEYS[1], 'traceCarrier', ARGV[7]) end
return 1
`;

export const endRunScript = `${guard}
require_type(KEYS[1], 'hash')
require_type(KEYS[2], 'zset')
require_type(KEYS[3], 'zset')
require_type(KEYS[4], 'set')
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
local score = redis.call('ZSCORE', KEYS[2], ARGV[1])
local statuses = redis.call('SMEMBERS', KEYS[4])
for _, status in ipairs(statuses) do redis.call('ZREM', ARGV[8] .. status, ARGV[1]) end
if score then redis.call('ZADD', KEYS[3], score, ARGV[1]) end
redis.call('SADD', KEYS[4], ARGV[2])
redis.call('HSET', KEYS[1], 'status', ARGV[2], 'endedAt', ARGV[3], 'isError', ARGV[4], 'durationMs', ARGV[5])
if ARGV[6] ~= '' then redis.call('HSET', KEYS[1], 'result', ARGV[6]) end
if ARGV[7] ~= '' then redis.call('HSET', KEYS[1], 'error', ARGV[7]) end
return 1
`;

export const appendEventScript = `${guard}
require_type(KEYS[1], 'hash')
require_type(KEYS[2], 'hash')
require_type(KEYS[3], 'zset')
if redis.call('EXISTS', KEYS[1]) == 0 then return {'missing'} end
if redis.call('HGET', KEYS[1], 'closed') == '1' then return {'closed'} end
local seq = tonumber(redis.call('HGET', KEYS[1], 'nextOffset') or '0')
redis.call('HSET', KEYS[2], tostring(seq), ARGV[1])
redis.call('ZADD', KEYS[3], seq, tostring(seq))
redis.call('HSET', KEYS[1], 'nextOffset', seq + 1)
return {'appended', tostring(seq)}
`;

export const appendEventOnceScript = `${guard}
require_type(KEYS[1], 'hash')
require_type(KEYS[2], 'hash')
require_type(KEYS[3], 'zset')
require_type(KEYS[4], 'hash')
local existing = redis.call('HGET', KEYS[4], ARGV[1])
if existing then
  local separator = string.find(existing, ':')
  local seq = string.sub(existing, 1, separator - 1)
  local data = string.sub(existing, separator + 1)
  if data ~= ARGV[2] then return {'conflict'} end
  return {'appended', seq}
end
if redis.call('EXISTS', KEYS[1]) == 0 then return {'missing'} end
if redis.call('HGET', KEYS[1], 'closed') == '1' then return {'closed'} end
local seq = tonumber(redis.call('HGET', KEYS[1], 'nextOffset') or '0')
redis.call('HSET', KEYS[2], tostring(seq), ARGV[2])
redis.call('ZADD', KEYS[3], seq, tostring(seq))
redis.call('HSET', KEYS[4], ARGV[1], tostring(seq) .. ':' .. ARGV[2])
redis.call('HSET', KEYS[1], 'nextOffset', seq + 1)
return {'appended', tostring(seq)}
`;

export const reserveSettlementScript = `${guard}
require_type(KEYS[1], 'hash')
for i = 2, 4 do require_type(KEYS[i], 'zset') end
if redis.call('HGET', KEYS[1], 'kind') ~= 'direct' or redis.call('HGET', KEYS[1], 'status') ~= 'running' or redis.call('HGET', KEYS[1], 'attemptId') ~= ARGV[1] or not redis.call('HGET', KEYS[1], 'ownerId') or redis.call('HEXISTS', KEYS[1], 'settlementRecordId') == 1 then return 0 end
local sequence = redis.call('HGET', KEYS[1], 'sequence')
redis.call('ZREM', KEYS[2], ARGV[2])
redis.call('ZADD', KEYS[3], sequence, ARGV[2])
redis.call('ZADD', KEYS[4], sequence, ARGV[2])
redis.call('HSET', KEYS[1], 'status', 'terminalizing', 'settlementRecordId', ARGV[3], 'settlementRecord', ARGV[4])
return 1
`;


export const finalizeSettlementScript = `${guard}
require_type(KEYS[1], 'hash')
require_type(KEYS[2], 'zset')
require_type(KEYS[3], 'zset')
if redis.call('HGET', KEYS[1], 'kind') ~= 'direct' or redis.call('HGET', KEYS[1], 'status') ~= 'terminalizing' or redis.call('HGET', KEYS[1], 'attemptId') ~= ARGV[3] or redis.call('HGET', KEYS[1], 'settlementRecordId') ~= ARGV[4] then return 0 end
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('HSET', KEYS[1], 'status', 'settled', 'settledAt', ARGV[2])
return 1
`;

export const closeEventScript = `${guard}
require_type(KEYS[1], 'hash')
if redis.call('EXISTS', KEYS[1]) == 1 then redis.call('HSET', KEYS[1], 'closed', 1) end
return 1
`;
