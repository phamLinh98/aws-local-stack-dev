require('dotenv').config();
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");

const REGION = process.env.AWS_REGION;
const ENDPOINT = process.env.DYNAMODB_ENDPOINT;
const CREDENTIALS = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
};

exports.connectToDynamoDb = async () => {
  const dynamoDB = new DynamoDBClient({
    region: REGION,
    endpoint: ENDPOINT,
    credentials: CREDENTIALS,
  });
  return dynamoDB;
};

exports.getInstanceDynamoDB = exports.connectToDynamoDb;