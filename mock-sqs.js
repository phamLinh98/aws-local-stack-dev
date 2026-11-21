const { SQSClient } = require('@aws-sdk/client-sqs');
const { clientConfig } = require('./local-config');
exports.connectToSQS = async () => new SQSClient({ ...clientConfig('SQS'), useQueueUrlAsEndpoint: false });
