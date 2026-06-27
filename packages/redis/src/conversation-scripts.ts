export const createConversationScript = `
local existing = redis.call('HGET', KEYS[1], 'identity')
if existing then
  if existing ~= ARGV[1] then return {'conflict'} end
  return {'existing'}
end
redis.call('HSET', KEYS[1], 'identity', ARGV[1], 'nextOffset', 0, 'closed', 0, 'producerEpoch', 0, 'nextProducerSequence', 0, 'incarnation', ARGV[2])
redis.call('SADD', KEYS[2], ARGV[3])
return {'created'}
`;

export const acquireConversationProducerScript = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'missing'} end
if redis.call('HGET', KEYS[1], 'closed') == '1' then return {'closed'} end
local epoch = tonumber(redis.call('HGET', KEYS[1], 'producerEpoch') or '0') + 1
local nextOffset = tonumber(redis.call('HGET', KEYS[1], 'nextOffset') or '0')
local incarnation = redis.call('HGET', KEYS[1], 'incarnation')
redis.call('HSET', KEYS[1], 'producerId', ARGV[1], 'producerEpoch', epoch, 'nextProducerSequence', 0)
return {'acquired', tostring(epoch), tostring(nextOffset), incarnation}
`;

export const appendConversationScript = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'missing'} end
if redis.call('HGET', KEYS[1], 'closed') == '1' then return {'closed'} end
if redis.call('HGET', KEYS[1], 'producerId') ~= ARGV[1] or redis.call('HGET', KEYS[1], 'producerEpoch') ~= ARGV[2] or redis.call('HGET', KEYS[1], 'incarnation') ~= ARGV[3] then return {'stale'} end
local retry = redis.call('HGET', KEYS[4], ARGV[2] .. ':' .. ARGV[4])
if retry then
  local stored = cjson.decode(retry)
  if stored.submissionId ~= ARGV[6] or stored.attemptId ~= ARGV[7] or stored.data ~= ARGV[5] then return {'conflict'} end
  return {'retry', tostring(stored.seq)}
end
if tonumber(redis.call('HGET', KEYS[1], 'nextProducerSequence') or '0') ~= tonumber(ARGV[4]) then return {'sequence'} end
local seq = tonumber(redis.call('HGET', KEYS[1], 'nextOffset') or '0')
local head = seq - 1
if ARGV[8] ~= '' and tonumber(ARGV[8]) ~= head then return {'head'} end
local batch = cjson.decode(ARGV[5])
if ARGV[6] ~= '' then
  local sessionKey = redis.call('HGET', KEYS[5], 'sessionKey')
  if not sessionKey or string.sub(sessionKey, 1, 14) ~= 'agent-session:' then return {'attempt'} end
  local sessionIdentity = cjson.decode(string.sub(sessionKey, 15))
  local status = redis.call('HGET', KEYS[5], 'status')
  local settlementRecord = redis.call('HGET', KEYS[5], 'settlementRecord')
  local terminalizingSettlement = status == 'terminalizing' and #batch == 1 and batch[1].type == 'submission_settled' and redis.call('HGET', KEYS[5], 'settlementRecordId') == batch[1].id and settlementRecord and ARGV[5] == '[' .. settlementRecord .. ']'
  if (status ~= 'running' and not terminalizingSettlement) or redis.call('HGET', KEYS[5], 'attemptId') ~= ARGV[7] or sessionIdentity[1] ~= ARGV[9] then return {'attempt'} end
end
redis.call('HSET', KEYS[2], tostring(seq), ARGV[5])
redis.call('ZADD', KEYS[3], seq, tostring(seq))
redis.call('HSET', KEYS[4], ARGV[2] .. ':' .. ARGV[4], cjson.encode({seq = seq, submissionId = ARGV[6], attemptId = ARGV[7], data = ARGV[5]}))
redis.call('HSET', KEYS[1], 'nextOffset', seq + 1, 'nextProducerSequence', tonumber(ARGV[4]) + 1)
return {'appended', tostring(seq)}
`;

export const readConversationScript = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'missing'} end
local nextOffset = tonumber(redis.call('HGET', KEYS[1], 'nextOffset') or '0')
local head = nextOffset - 1
if tonumber(ARGV[1]) > head then return {'offset'} end
local sequences = redis.call('ZRANGEBYSCORE', KEYS[2], '(' .. ARGV[1], '+inf', 'LIMIT', 0, tonumber(ARGV[2]) + 1)
local result = {'read', tostring(head), redis.call('HGET', KEYS[1], 'closed') or '0', redis.call('HGET', KEYS[1], 'incarnation')}
for _, sequence in ipairs(sequences) do
  local data = redis.call('HGET', KEYS[3], sequence)
  if not data then return {'malformed'} end
  table.insert(result, sequence)
  table.insert(result, data)
end
return result
`;

export const closeConversationScript = `
if redis.call('EXISTS', KEYS[1]) == 1 then redis.call('HSET', KEYS[1], 'closed', 1) end
return 1
`;

export const deleteConversationScript = `
redis.call('DEL', KEYS[1], KEYS[2], KEYS[3], KEYS[4])
redis.call('SREM', KEYS[5], ARGV[1])
return 1
`;
