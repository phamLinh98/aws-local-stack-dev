# Local AWS Lab

Mock server chạy local với UI quản lý Lambda, S3, DynamoDB, SQS và Secrets Manager. Không cần tài khoản AWS hoặc Docker. Đây là mock riêng cho phát triển, không phải sản phẩm LocalStack và không giả lập đầy đủ AWS.

## Chạy ứng dụng

Yêu cầu Node.js 22 trở lên.

```bash
npm install
npm start
```

Mở **http://127.0.0.1:8001**. Cấu hình mặc định chạy được không cần `.env`. Muốn tùy chỉnh, sao chép `.env.example` thành `.env` nếu chưa có, sau đó chỉnh port hoặc tên tài nguyên. Server chỉ lắng nghe trên `127.0.0.1`.

```bash
npm run dev # Node watch mode; restart backend sẽ reset dữ liệu
npm test    # test tích hợp bằng AWS SDK, gồm Lambda timeout (~10 giây)
```

## Thao tác trên UI

- **Overview:** số tài nguyên, số file/message, lịch sử 100 thao tác gần nhất và reset workspace.
- **Lambda:** tạo function, sửa JavaScript, nhập JSON event, lưu/chạy test, xem return value và stdout/stderr.
- **S3 Storage:** tạo bucket, upload file tối đa 20 MB, dùng object key có thư mục, download và xóa object.
- **DynamoDB:** tạo table có partition key `id` kiểu chuỗi, xem item, sửa/thêm item bằng DynamoDB JSON, xóa theo key. Ghi cùng khóa sẽ thay thế item.
- **SQS:** tạo queue, gửi body, receive tối đa 10 message, xem trạng thái available/in-flight, xóa message đã nhận. Visibility timeout mặc định trên UI: 30 giây. Bấm Refresh để cập nhật trạng thái.
- **Secrets Manager:** tạo secret, load và sửa giá trị text/JSON.
- **Connection:** endpoint và ví dụ cấu hình AWS SDK.

**Dữ liệu lưu trong RAM:** file, function, secret, bảng và queue mới mất khi restart hoặc reset. Reset khôi phục fixtures ban đầu; UI hỏi xác nhận trước khi reset/xóa. Chỉ dùng dữ liệu test và secret giả.

## Lambda local

Dùng CommonJS và handler async:

```js
exports.handler = async (event, context) => {
  console.log('Event:', event);
  return { statusCode: 200, body: JSON.stringify(event) };
};
```

Mỗi lần invoke chạy trong process Node riêng, timeout 10 giây, tối đa 4 invocation đồng thời, log giới hạn khoảng 64 KB. `require()` truy cập package đã cài trong repo. Chưa hỗ trợ ZIP, Python, callback handler, layers hoặc tự động trigger từ S3/SQS.

Runner cấp region, credentials `test`, `AWS_ENDPOINT_URL`, `DYNAMODB_ENDPOINT`, `S3_ENDPOINT`, `SQS_ENDPOINT`, `SECRETS_ENDPOINT`. Không truyền nguyên môi trường AWS của máy sang child process. Có thể dùng SDK bên trong function để gọi mock server:

```js
exports.handler = async () => {
  const { DynamoDBClient, ListTablesCommand } = require('@aws-sdk/client-dynamodb');
  const client = new DynamoDBClient({}); // đọc endpoint/region/credentials được cấp
  try {
    return await client.send(new ListTablesCommand({}));
  } finally {
    client.destroy();
  }
};
```

**Đây không phải sandbox:** code Lambda chạy với quyền user hiện tại, có thể đọc/ghi file hoặc gọi mạng. Chỉ chạy code bạn tin cậy. Timeout dừng process handler, không bảo đảm quản lý subprocess do code tự tạo. Không triển khai server này ra internet.

## Kết nối ứng dụng bên ngoài

UI và SDK dùng chung dữ liệu. Dùng endpoint loopback và credentials giả:

```js
const { S3Client } = require('@aws-sdk/client-s3');
const s3 = new S3Client({
  endpoint: 'http://127.0.0.1:8001',
  region: 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  forcePathStyle: true,
  requestChecksumCalculation: 'WHEN_REQUIRED',
});
```

Các helper `mock-db.js`, `mock-s3.js`, `mock-sqs.js`, `mock-secret.js` vẫn giữ tên export cũ. Chúng dùng credentials `test`, có endpoint mặc định local và từ chối endpoint ngoài loopback. Với SQS, lấy QueueUrl hiện tại từ UI hoặc `GetQueueUrl` / `ListQueues`; URL seed được chuẩn hóa về server local. `.env` hiện có không bị ghi đè.

## Phạm vi API

| Service | Hỗ trợ |
| --- | --- |
| DynamoDB | ListTables, CreateTable, PutItem, GetItem, DeleteItem, Scan với một phép bằng, UpdateItem với các phép `SET field = :value` |
| S3 | Path-style CreateBucket, PutObject, GetObject, HeadObject, DeleteObject, list objects theo prefix |
| SQS | CreateQueue, GetQueueUrl, ListQueues, SendMessage, ReceiveMessage, DeleteMessage, PurgeQueue |
| Secrets | ListSecrets, CreateSecret, PutSecretValue, GetSecretValue |
| Lambda | Lưu source/invoke qua console API, chưa có AWS Lambda control-plane API |

Giới hạn: không IAM/signature validation, DynamoDB transactions/index/pagination/full expressions, S3 multipart/streaming aws-chunked, queue FIFO/DLQ/long polling hoặc event source mapping. Presigned URL không được kiểm tra chữ ký/hết hạn. Một số tùy chọn AWS chưa được mô phỏng; test local không chứng minh tương thích toàn bộ AWS. JSON request tối đa 1 MB; source function tối đa 100.000 ký tự.

## Cấu trúc

- `index.js`: cấu hình và khởi động loopback server.
- `server.js`: state, console API, các route tương thích một phần AWS SDK.
- `lambda-worker.js`: runner cho async JavaScript handler.
- `public/`: UI HTML/CSS/JavaScript thuần, không cần build hoặc CDN.
- `local-config.js`, `mock-*.js`: helper SDK local.
- `test/integration.test.js`: kiểm tra SDK, chia sẻ state, runner và kiểm soát truy cập.
- `mock.js`: script cũ dành riêng cho Lambda ở `../src/lambda/...`; cần source bên ngoài repo. UI Lambda mới không phụ thuộc script này.

`GET /health` kiểm tra server. `GET /api/state` cung cấp trạng thái cho UI. Console write API yêu cầu header `x-local-console: 1`; không mở CORS. Host/origin ngoài local bị từ chối.
