require('dotenv').config({ quiet: true });

// Helpers in this repository always target a local mock, never an AWS endpoint.
exports.clientConfig = service => {
  const endpoint = process.env[`${service}_ENDPOINT`] || `http://127.0.0.1:${process.env.PORT || 8001}`;
  const url = new URL(endpoint);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${service}_ENDPOINT must point to a loopback address for local testing.`);
  }
  return {
    region: process.env.AWS_REGION || 'us-east-1',
    endpoint,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  };
};
