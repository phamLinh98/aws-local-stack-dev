require('dotenv').config();
const { GetSecretValueCommand, SecretsManagerClient } = require("@aws-sdk/client-secrets-manager");

const { clientConfig } = require('./local-config');
const secret_name = process.env.SECRET_NAME || 'local-config';
exports.secretsClient = new SecretsManagerClient(clientConfig('SECRETS'));

exports.getSecretOfKey = async (key) => {
  try {
    const response = await exports.secretsClient.send(
      new GetSecretValueCommand({
        SecretId: secret_name,
        VersionStage: "AWSCURRENT",
      })
    );

    const secretString = response.SecretString;
    if (!secretString) {
      console.error("❌ No SecretString returned");
      return undefined;
    }

    const secrets = JSON.parse(secretString);

    if (!(key in secrets)) {
      console.warn(`⚠️ Key "${key}" not found in secrets`);
      return undefined;
    }

    return secrets[key];
  } catch (error) {
    console.error("❌ Error getting secret:", error);
    throw error;
  }
};