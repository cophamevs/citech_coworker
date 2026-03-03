# Buổi 30: Arduino - Thế Giới Điện Tử

## Thông Tin Buổi Học
- **Độ tuổi**: 12-14 tuổi
- **Thời lượng**: 90 phút
- **Lĩnh vực**: Kỹ thuật (Điện tử)

## Mục Tiêu Buổi Học
1. Hiểu về Arduino
2. Lắp mạch điện đơn giản
3. Lập trình điều khiển LED

## Nội Dung Lý Thuyết (15 phút)

### Arduino là gì?
- Vi điều khiển (microcontroller)
- Có thể lập trình để điều khiển thiết bị điện
- Rất phổ biến trong STEM
- Dùng trong robot, IoT, tự động hóa

### Arduino UNO:
- Có 13 chân digital
- Có 6 chân analog
- Nạp code qua USB

### Cấu trúc chương trình:
```cpp
void setup() {
  // Chạy một lần khi bắt đầu
}

void loop() {
  // Chạy lặp đi lặp lại
}
```

## Hoạt Động Thực Hành (65 phút)

### Hoạt động 1: LED nhấp nháy (30 phút)
**Vật liệu:**
- Arduino UNO
- LED
- Điện trở 220Ω
- Dây nối
- Breadboard

**Sơ đồ mạch:**
- Chân dài LED → Pin 13
- Chân ngắn LED → Điện trở → GND

**Code:**
```cpp
void setup() {
  pinMode(13, OUTPUT);
}

void loop() {
  digitalWrite(13, HIGH);
  delay(1000);
  digitalWrite(13, LOW);
  delay(1000);
}
```

### Hoạt động 2: LED với nút bấm (20 phút)
**Vật liệu:**
- Thêm 1 nút bấm

**Code:**
```cpp
void setup() {
  pinMode(13, OUTPUT);
  pinMode(2, INPUT_PULLUP);
}

void loop() {
  if (digitalRead(2) == LOW) {
    digitalWrite(13, HIGH);
  } else {
    digitalWrite(13, LOW);
  }
}
```

### Hoạt động 3: LED đổi màu RGB (15 phút)
- Thử với LED RGB
- Điều chỉnh màu sắc

## Bài Tập Về Nhà
- Làm đèn giao thông đơn giản
- Tìm hiểu thêm về cảm biến
