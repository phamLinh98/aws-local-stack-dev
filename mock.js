require('dotenv').config();
const { handler } = require("../src/lambda/get-csv-read-detail-update-inprocessing-lambda");

(async () => {
  const event = {
    queryStringParameters: {
      id: "123",
    },
    Records: [
      {
        receiptHandle: "VALID_RECEIPT_HANDLE_FROM_RECEIVE_MESSAGE",
        s3: {
          bucket: {
            name: process.env.UPLOAD_CSV_TABLE_NAME,
          },
          object: {
            key:
              process.env.TEST_S3_OBJECT_KEY,
          },
        },
        body: JSON.stringify({
          fileId: process.env.TEST_FILE_ID,
        }),
      },
    ],
  };

  const result = await handler(event);
  console.log("🔍 Lambda result:", result);
})();