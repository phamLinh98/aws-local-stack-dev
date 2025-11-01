# aws-local-stack-dev

Một mock server nhỏ để mô phỏng các dịch vụ AWS (DynamoDB, S3, Secrets Manager, SQS) trong môi trường phát triển cục bộ.

Mục đích
 - Cho phép phát triển và kiểm thử lambda / service phụ thuộc các dịch vụ AWS mà không cần truy cập AWS thật.
 - Trả về các phản hồi JSON đơn giản tương tự API của AWS (PutItem, Scan, UpdateItem, ListQueues, SendMessage, GetSecretValue...).

Những gì được mock
 - DynamoDB: PutItem, Scan, UpdateItem, ListTables (dữ liệu lưu trong bộ nhớ)
 - S3: (kết nối client trả về endpoint mock — hành động file không được persist)
 - Secrets Manager: GetSecretValue (trả về chuỗi secret đã cấu hình trong server)
 - SQS: ListQueues, SendMessage (tính MD5 cho message body và trả về MessageId)

Cấu trúc project (chỉ các file chính)
 - `index.js` — entrypoint của mock server (Express) và các handler cho DynamoDB / S3 / Secrets / SQS
 - `mock-db.js`, `mock-s3.js`, `mock-secret.js`, `mock-sqs.js` — helpers để khởi tạo các client AWS SDK trong môi trường local (đã chuyển sang đọc từ `process.env`)
 - `mock.js` — script nhỏ để gọi một handler lambda mẫu với event giả lập
 - `.env` — tập hợp các biến môi trường (không commit giá trị nhạy cảm vào VCS)

Chạy mock server

1) Cài phụ thuộc (chỉ cần 1 lần):

```bash
npm install
```

2) Tạo hoặc cập nhật file `.env` ở gốc project với các biến mong muốn (README này không liệt kê giá trị cụ thể — chỉ tên biến). Ví dụ các tên biến bạn có thể đặt:

- `PORT`
- `AWS_REGION`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `DYNAMODB_ENDPOINT`
- `S3_ENDPOINT`
- `SECRETS_ENDPOINT`
- `SQS_ENDPOINT`
- `SECRET_NAME`
- `UPLOAD_CSV_TABLE_NAME`
- `BUCKET_CSV_NAME`
- `SQS_NAME`
- `PREFIX_QUEUE_URL`
- `QUEUE_URL_1`, `QUEUE_URL_2`

3) Start server:

```bash
# chạy foreground
node index.js

# hoặc chạy background (macOS / zsh)
node index.js &
```

Kiểm thử nhanh (smoke test)

Gửi một POST tới root với header `x-amz-target: AmazonSQS.ListQueues` sẽ trả về danh sách queue URL mock (thay header để thử các target khác như `DynamoDB_20120810.Scan`):

```bash
curl -s -X POST http://localhost:8001 \
	-H "x-amz-target: AmazonSQS.ListQueues" \
	-H "Content-Type: application/x-amz-json-1.0" \
	-d '{}' | jq .
```

Lưu ý
 - README này KHÔNG tiết lộ bất kỳ giá trị trong `.env` — chỉ tên biến được liệt kê để bạn cấu hình riêng.
 - Mock server lưu trữ dữ liệu trong bộ nhớ (RAM). Khởi động lại server sẽ xóa dữ liệu mock.
 - File `mock.js` và các file helper đã được chuyển để đọc cấu hình từ `process.env`. Nếu muốn, bạn có thể chuyển toàn bộ dự án sang ESM hoặc giữ CommonJS cho nhất quán.

Gợi ý phát triển
 - Nếu bạn muốn mock phức tạp hơn (ví dụ lưu persistence, nhiều trạng thái message, dead-letter handling), tôi có thể mở rộng server để persist vào file JSON tạm hoặc cung cấp endpoints HTTP để reset/inspect state.

Liên hệ
 - Nếu cần tôi cập nhật code để log rõ ràng hơn, thêm endpoints kiểm tra, hoặc chạy smoke-tests tự động, nói tôi biết — tôi có thể thực hiện các thay đổi nhỏ ngay lập tức.
