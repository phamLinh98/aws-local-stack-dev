require('dotenv').config();
const { GetSecretValueCommand, SecretsManagerClient } = require("@aws-sdk/client-secrets-manager");

const REGION = process.env.AWS_REGION;
const ENDPOINT = process.env.SECRETS_ENDPOINT;
const CREDENTIALS = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
};
const secret_name = process.env.SECRET_NAME;

exports.secretsClient = new SecretsManagerClient({
  region: REGION,
  endpoint: ENDPOINT,
  credentials: CREDENTIALS,
});

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
    console.log("🔐 Secrets:", secrets);

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