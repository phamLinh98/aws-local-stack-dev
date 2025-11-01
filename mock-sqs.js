require('dotenv').config();
const { SQSClient } = require("@aws-sdk/client-sqs");

const REGION = process.env.AWS_REGION;
const ENDPOINT = process.env.SQS_ENDPOINT;
const CREDENTIALS = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
};

exports.connectToSQS = async () => {
  const sqs = new SQSClient({
    region: REGION,
    endpoint: ENDPOINT,
    credentials: CREDENTIALS,
  });
  return sqs;
};