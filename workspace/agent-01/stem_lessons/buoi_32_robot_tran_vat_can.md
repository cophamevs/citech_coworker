# Buổi 32: Robot Tránh Vật Cản

## Thông Tin Buổi Học
- **Độ tuổi**: 10-14 tuổi
- **Thời lượng**: 90 phút
- **Lĩnh vực**: Kỹ thuật (Robotics)

## Mục Tiêu Buổi Học
1. Hiểu về cảm biến siêu âm
2. Lập trình robot tránh vật cản
3. Phát triển tư duy logic

## Nội Dung Lý Thuyết (15 phút)

### Cảm biến siêu âm (Ultrasonic):
- Phát sóng siêu âm
- Đo thời gian sóng phản hồi
- Tính khoảng cách đến vật

### Nguyên lý:
```
Khoảng cách = (Thời gian × Tốc độ âm thanh) / 2
```

### Ứng dụng:
- Robot hút bụi
- Xe tự hành
- Cảm biến đỗ xe ô tô

## Hoạt Động Thực Hành (65 phút)

### Hoạt động 1: Test cảm biến (20 phút)
**Với LEGO Spike / micro:bit:**
1. Lắp cảm biến khoảng cách
2. Viết code đọc khoảng cách
3. Hiển thị lên màn hình

**Code mẫu (micro:bit):**
```
đọc khoảng cách (cm) từ chân P1
nếu khoảng cách < 10
  hiển thị "DỪNG!"
khác
  hiển thị khoảng cách
```

### Hoạt động 2: Robot tránh vật cản (30 phút)
**Logic:**
1. Đo khoảng cách phía trước
2. Nếu < 15cm → rẽ hướng khác
3. Nếu > 15cm → đi thẳng

**Code:**
```
lặp mãi mãi
  khoang_cach = đọc_cam_bien()
  nếu khoang_cach < 15
    dừng động cơ
    rẽ trái 90 độ
  khác
    đi thẳng với tốc độ 50
```

### Hoạt động 3: Thử nghiệm (15 phút)
- Chạy thử robot
- Điều chỉnh tốc độ
- Thay đổi góc rẽ

## Bài Tập Về Nhà
- Tối ưu hóa code tránh vật cản
- Thêm âm thanh cảnh báo
