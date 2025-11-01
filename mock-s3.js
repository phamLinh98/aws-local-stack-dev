// connectToS3.ts
require('dotenv').config();
const { S3Client } = require("@aws-sdk/client-s3");
// Note: addCorsHeaders and getSignedUrl were referenced before; keep imports if needed
let addCorsHeaders;
try {
  addCorsHeaders = require("./mock-cors").addCorsHeaders;
} catch (e) {
  addCorsHeaders = undefined;
}

const REGION = process.env.AWS_REGION;
const ENDPOINT = process.env.S3_ENDPOINT;
const CREDENTIALS = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
};

exports.connectToS3Bucket = async () => {
  const s3 = new S3Client({
    region: REGION,
    endpoint: ENDPOINT,
    credentials: CREDENTIALS,
  });
  return s3;
};
