# Local AWS Lab

Console học AWS trên local, giao diện lấy cảm hứng từ AWS Console. Không cần AWS account. Hỗ trợ 10 service với mock API và Docker workload thật; không mô phỏng toàn bộ AWS.

## Clone và chạy

Cài Docker Desktop với Linux containers (Windows dùng WSL2), Docker Engine + Compose trên Linux, hoặc Colima trên macOS. Image mặc định hỗ trợ Linux amd64/arm64; image bạn tự chọn phải hỗ trợ kiến trúc máy. Lần đầu cần internet để tải image, dung lượng vài GB. Nên cấp Docker ít nhất 4 GB RAM khi chạy compiler/database cùng lúc.

```bash
git clone https://github.com/phamLinh98/aws-local-stack-dev.git
cd aws-local-stack-dev
docker compose up --build -d
```

Mở **http://127.0.0.1:8001**. Với bản cài Compose độc lập, dùng `docker-compose` thay `docker compose`.

```bash
docker compose stop        # dừng console, giữ dữ liệu
docker compose start       # mở lại console
docker compose logs -f console
```

EC2/ECS/RDS/registry được console tạo trực tiếp trên Docker engine, nên vẫn tồn tại độc lập khi console dừng. Dùng nút Stop hoặc scale ECS về 0 để giải phóng RAM. Không dùng `down -v` nếu muốn giữ volume workspace.

Compose gắn Docker socket vào console để tạo container. Chỉ dùng trên máy cá nhân với code/image tin cậy và giữ cổng loopback; Docker socket có quyền quản trị engine. Đây chưa phải sản phẩm đa người dùng hay dịch vụ public.

## Chạy bằng Node

Node.js >=22.13 và Docker đang chạy:

```bash
npm ci
npm start
```

Không cần cài Java/.NET/Go trên host. Runtime tải và chạy trong Docker. Có thể chạy các mock service cùng Node Lambda khi Docker offline; UI báo rõ Docker unavailable.

Biến cấu hình: `PORT` (8001), `DATA_DIR` (mặc định `.local-aws`), `REGISTRY_PORT` (5001). `.env.example` chứa cấu hình mẫu. Không commit `.env` hoặc database. Node 22 có thể hiển thị ExperimentalWarning cho SQLite.

## Lưu dữ liệu

- Mock DynamoDB, S3 (cả binary/version), SQS, secrets, function, layer, log, metric và cấu hình tài nguyên lưu trong SQLite; commit trước khi trả response thành công.
- Node mode dùng `.local-aws/workspace.sqlite`; Compose dùng named volume `workspace` tại `/data`.
- RDS và registry dùng Docker named volume riêng, không mất khi stop/restart.
- SQLite hiện lưu snapshot workspace, phù hợp lab cá nhân và dữ liệu nhỏ; không dành cho tải lớn. Chỉ chạy một console cho một DATA_DIR. Muốn backup Node workspace, dừng app rồi sao chép cả thư mục DATA_DIR; RDS cần backup database/volume riêng.
- Reset UI khôi phục fixtures và xóa mock data. Reset bị chặn khi có infrastructure để tránh mất liên kết container. Chọn DATA_DIR mới để tạo workspace mới.

## Tính năng

| Service | Thao tác |
| --- | --- |
| Lambda | Node.js, Java 21, C#/.NET 8, Go 1.24; source editor, JSON event, log/result; versioned source layers; timeout 1–120 giây; concurrency 1–4 |
| S3 | Bucket/object CRUD, download, versioning, delete marker, tải version cũ, lifecycle current/noncurrent expiration theo prefix |
| DynamoDB | Table/item CRUD, Scan equality, Query partition equality, SET updates, TTL Unix seconds, backup/restore |
| SQS | Queue CRUD subset, gửi/nhận/xóa, delay qua API, visibility timeout, DLQ redrive theo receive count |
| Secrets Manager | Tạo/đọc/sửa, lịch sử version và restore |
| EC2 | Linux container, chọn 128/512/1024 MB, start/stop/terminate, shell exec, commit thành Docker image |
| ECR | Repository metadata, registry thật với persistent volume, tag/push/pull image |
| ECS | Cluster/service, chạy Docker image, scale 0–4 task, port loopback tự cấp, collect logs |
| CloudWatch | Log group Lambda/EC2/ECS/RDS, metric Lambda tự ghi, sample CPU/RAM container, threshold alarm |
| RDS | PostgreSQL 16/MySQL 8.4 thật, persistent volume, start/stop, SQL editor và connection credentials |

**Giới hạn EC2:** mỗi container dùng `--memory` và `--memory-swap` bằng nhau; tổng memory limit của EC2 đang chạy trên engine tối đa 1024 MB. Docker engine, console, RDS/ECS và compiler không nằm trong budget này. EC2 là Linux container dùng chung kernel, không phải VM/AMI/VPC. Stop giữ writable layer; terminate xóa writable layer. Shell exec tối đa 15 giây.

## Lambda và layer

Node chạy child process, Java/C#/Go compile trong container có memory/pid/CPU limit. Node memory setting giới hạn V8 heap, không giới hạn toàn bộ RSS. Tất cả code phải tin cậy; Node có quyền filesystem/network của user.

Hợp đồng handler local:

- Node: `exports.handler = async (event, context) => result`.
- Java: `public class Handler { public static String handle(String event) { return event; } }`. Input/output là chuỗi JSON.
- C#: `public static class Handler { public static object Handle(System.Text.Json.JsonElement input) => input; }`.
- Go: `package main; func Handle(event json.RawMessage) (any, error)`.

Mỗi runtime có sample trong UI. **Prepare runtime image** tải image trước. Lần đầu invoke cần compile, có thể chậm. SDK endpoint/credentials giả được cấp qua environment; container mode dùng `http://console:8001`. Host mode container dùng `host.docker.internal`; nếu host chỉ bind 127.0.0.1, truy cập mock từ runtime container có thể không hoạt động trên một số Linux setup — dùng Compose là luồng khuyến nghị.

Layer là JSON mapping path → source text, có version, gắn tối đa 5 layer cùng runtime vào function. Node có thể `require('shared')` từ `shared.js`; Java compile `.java`, C# compile `.cs`, Go compile `.go` dùng package main. Chưa hỗ trợ ZIP/binary dependency layer hoặc Lambda runtime API đầy đủ.

“Replica” trong UI là reserved concurrency local (1–4), chưa giữ sẵn warm process/provisioned concurrency. Tối đa 4 invocation toàn app. Chưa có trigger S3/SQS, alias, SnapStart hoặc IAM.

## Bài thực hành ECR → ECS

1. Tạo repository `my-app` trong ECR, push source image `nginx:alpine`, tag `v1`.
2. Copy image URL `localhost:5001/my-app:v1`.
3. Tạo ECS cluster, deploy service với URL đó, memory 128 MB và container port 80.
4. Xem port host được cấp, mở `http://127.0.0.1:<port>`, scale 1–4 task.
5. Collect logs rồi xem CloudWatch. Scale về 0 để dừng.

EC2 Commit tạo image trên Docker engine; nhập image tag này làm source ECR để tag/push. Registry dùng loopback HTTP; không cung cấp authentication hoặc scan image. ECS reconcile khi Deploy/Scale; chưa tự thay task chết hoặc có load balancer.

## Lifecycle, TTL, metrics

Lifecycle/TTL được đánh giá mỗi phút khi console chạy; có nút đánh giá trước 0–3650 ngày để học expiration. Đây là thao tác có thay đổi dữ liệu; UI hỏi xác nhận. Lifecycle dùng expiration rule đơn giản, chưa storage class transition hoặc multipart expiration. Version history có thể tải từng version.

Alarm so sánh sample mới nhất với threshold `>=`, chưa aggregation window, notification hoặc CloudWatch query language. Invocations ghi mỗi invocation một sample 1, không phải tổng tích lũy. Container metrics lấy khi bấm Sample.

## AWS SDK và phạm vi tương thích

DynamoDB/SQS/Secrets giữ endpoint JSON cũ; S3 dùng path-style HTTP. Helper `mock-*.js` dùng credentials `test` và endpoint loopback. S3 cần `forcePathStyle:true` và `requestChecksumCalculation:'WHEN_REQUIRED'`. UI Connection có ví dụ.

EC2/ECS/ECR/RDS/CloudWatch mới dùng `/api/<service>` của console, chưa tương thích AWS control-plane API. Version/lifecycle/layer/backup cũng được cấu hình qua console API. Không IAM/signature verification, không full DynamoDB expressions/index/transaction, S3 multipart hoặc SQS FIFO/long polling. Presigned URL không kiểm tra chữ ký/hết hạn. Mock thành công không chứng minh tương thích hoàn toàn với AWS.

## Kiểm tra

```bash
npm test             # SDK + persistence restart + feature tests
npm run test:docker  # compile 3 runtime, EC2 limits, ECR→ECS, PostgreSQL restart
```

Docker tests tạo tài nguyên tạm và dọn container/volume của test. EC2 budget test bỏ qua nếu workspace khác đang dùng EC2 để không tác động workload đó. Không tự xóa image compiler đã tải.

## Duyệt dữ liệu theo bảng

DynamoDB hiển thị các thuộc tính thành cột (tự lấy hợp tất cả field), có nhãn kiểu dữ liệu, key, NULL và field thiếu. Nút Edit JSON vẫn giữ định dạng AWS AttributeValue để sửa map/list/set và số chính xác.

RDS: bấm **Load / reload tables**, chọn `schema.table`, mở **Columns & structure** để xem kiểu cột/default/nullable. Dữ liệu có phân trang 50 dòng, Refresh rows, Previous/Next. Giá trị được hiển thị dạng text để giữ chính xác bigint/decimal; binary hiển thị hex. Grid chỉ đọc; thêm/sửa/xóa bằng SQL editor rồi Refresh rows. Browser hiện dùng database `lab` của instance và các user schema trong database đó. Khi bảng thay đổi đồng thời hoặc khóa sắp xếp bị trùng, phân trang offset có thể thay đổi giữa các lần tải.

## EC2 Ubuntu terminal

EC2 mới mặc định dùng `ubuntu:24.04`. Launch/Start tự kết nối màn hình Linux nền đen; nút **Connect terminal** mở lại shell khi bị ngắt. Terminal có PTY thật, hỗ trợ `cd`, biến môi trường, phím mũi tên, Ctrl+C và resize. Gõ `exit` để đóng shell. Đổi trang hoặc Refresh đóng phiên shell, nhưng file trong instance vẫn giữ đến khi Terminate. Phiên không thao tác 15 phút tự ngắt; kết nối lại tạo shell mới. Instance cũ giữ image hiện tại; tạo instance mới để dùng Ubuntu.

Terminal chạy bằng root bên trong container có giới hạn RAM cũ, không phải root trên host. Container vẫn thuộc môi trường học local, không mở console ra internet. Kết nối terminal dùng WebSocket cùng origin và ticket dùng một lần. Node mode đọc Docker socket từ DOCKER_HOST hoặc docker context; hỗ trợ Unix socket / Windows named pipe. Remote Docker qua TCP/SSH chưa hỗ trợ terminal.

```bash
npm run test:terminal # cần Docker và image Ubuntu; test PTY, shell state, resize, origin
```
