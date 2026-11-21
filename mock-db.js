const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { clientConfig } = require('./local-config');
exports.connectToDynamoDb = async () => new DynamoDBClient(clientConfig('DYNAMODB'));
exports.getInstanceDynamoDB = exports.connectToDynamoDb;
