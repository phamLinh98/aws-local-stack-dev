const { S3Client } = require('@aws-sdk/client-s3');
const { clientConfig } = require('./local-config');
exports.connectToS3Bucket = async () => new S3Client({
  ...clientConfig('S3'),
  forcePathStyle: true,
  requestChecksumCalculation: 'WHEN_REQUIRED',
});
