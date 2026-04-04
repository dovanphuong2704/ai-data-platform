Hướng dẫn cài đặt pgvector cho PostgreSQL trong Docker
Bước 1: Truy cập vào trong Container
Mở terminal trên server và truy cập vào container với quyền root:

Bash
docker exec -u 0 -it postgis bash
Bước 2: Cập nhật hệ thống và cài đặt công cụ Build
Do container mặc định rất tinh gọn, bạn cần cài đặt các thư viện hỗ trợ biên dịch:

Bash
apt-get update
apt-get install -y git build-essential postgresql-server-dev-15 clang-13
Lưu ý: clang-13 là bắt buộc vì cấu hình Postgres 15 của bạn yêu cầu biên dịch JIT (bitcode).

Bước 3: Tải mã nguồn pgvector từ GitHub
Di chuyển vào thư mục tạm và tải phiên bản ổn định:

Bash
cd /tmp
git clone --branch v0.8.0 https://github.com/pgvector/pgvector.git
cd pgvector
Bước 4: Biên dịch và Cài đặt
Thực hiện build extension từ mã nguồn:

Bash
make clean
make
make install
Bước 5: Kiểm tra file Extension
Xác nhận các file điều khiển đã nằm đúng vị trí trong hệ thống của Postgres:

Bash
ls /usr/share/postgresql/15/extension/vector.control
Bước 6: Kích hoạt Extension qua DBeaver
Quay lại công cụ DBeaver, mở SQL Editor và chạy lệnh:

SQL
-- Kích hoạt extension cho database hiện tại
CREATE EXTENSION IF NOT EXISTS vector;

-- Kiểm tra danh sách extension đã cài đặt
SELECT extname, extversion FROM pg_extension WHERE extname IN ('postgis', 'vector');