# Buổi 14: Scratch Nâng Cao - Điều Khiển Nhân Vật

## Thông Tin Buổi Học
- **Độ tuổi**: 8-14 tuổi
- **Thời lượng**: 90 phút
- **Lĩnh vực**: Công nghệ (Lập trình)

## Mục Tiêu Buổi Học
1. Sử dụng các phím điều khiển
2. Tạo tương tác với nhân vật
3. Làm quen với khối điều kiện

## Nội Dung Lý Thuyết (15 phút)

### Điều khiển bằng bàn phím:
- Mỗi phím có một mã
- Dùng khối "nếu phím ... được nhấn"
- Có thể điều khiển nhiều hướng

### Khối điều kiện:
```
nếu <điều kiện> thì
  [làm gì đó]
```

### Tọa độ trong Scratch:
- Trục X: Trái (-) sang Phải (+)
- Trục Y: Dưới (-) lên Trên (+)
- Tâm sân khấu: (0, 0)

## Hoạt Động Thực Hành (65 phút)

### Hoạt động 1: "Điều khiển bằng phím" (25 phút)
**Mục tiêu:** Dùng phím mũi tên để di chuyển nhân vật

**Các bước:**
1. Tạo biến "tốc độ"
2. Dùng khối "nếu phím mũi tên phải được nhấn"
3. Trong khối đó, thêm "thay đổi x của em (sprite) 5"
4. Làm tương tự với các hướng khác

**Code mẫu:**
```
khi bấm cờ xanh
lặp lại mãi mãi
  nếu phím mũi tên phải được nhấn thì
    thay đổi x của em (sprite) cho 5
  nếu phím mũi tên trái được nhấn thì
    thay đổi x của em (sprite) cho -5
  nếu phím mũi tên lên được nhấn thì
    thay đổi y của em (sprite) cho 5
  nếu phím mũi tên xuống được nhấn thì
    thay đổi y của em (sprite) cho -5
```

### Hoạt động 2: "Né vật cản" (25 phút)
**Mục tiêu:** Nhân vật né tránh vật cản

**Các bước:**
1. Thêm 1 nhân vật mới (vật cản)
2. Lập trình cho vật cản di chuyển ngẫu nhiên
3. Kiểm tra va chạm: "nếu chạm vào em (sprite)"
4. Nếu chạm, hiển thị "Game Over"

**Code cho vật cản:**
```
khi bấm cờ xanh
đi tới vị trí ngẫu nhiên
lặp lại mãi mãi
  trượt trong 1 giây tới vị trí ngẫu nhiên
```

### Hoạt động 3: "Thu thập điểm" (15 phút)
**Mục tiêu:** Thu thập vật phẩm để được điểm

**Các bước:**
1. Tạo biến "điểm số"
2. Thêm nhân vật mới (đồng xu, ngôi sao)
3. Khi chạm vào đồng xu:
   - Ẩn đồng xu
   - Tăng điểm số 1
   - Đợi 1 giây, hiển lại ở vị trí mới

## Bài Tập Về Nhà
- Làm game đơn giản có điều khiển bằng phím
- Thêm điểm số và hiển thị khi thắng
