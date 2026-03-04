# Buổi 16: Scratch - Game Bắn Bong Bóng

## Thông Tin Buổi Học
- **Độ tuổi**: 8-14 tuổi
- **Thời lượng**: 90 phút
- **Lĩnh vực**: Công nghệ (Lập trình - Game)

## Mục Tiêu Buổi Học
1. Tạo game bắn bong bóng
2. Sử dụng khối lặp và điều kiện
3. Xử lý va chạm trong game

## Nội Dung Lý Thuyết (15 phút)

### Game bắn bong bóng:
- Người chơi điều khiển súng
- Bắn các quả bong bóng bay lên
- Bong bóng nổ khi chạm đạn

### Các yếu tố cần thiết:
1. **Súng/người chơi**: Di chuyển trái-phải
2. **Bong bóng**: Bay ngẫu nhiên lên trên
3. **Đạn**: Bắn lên khi bấm phím
4. **Điểm số**: Đếm số bong bóng bị bắn trúng
5. **Thời gian**: Giới hạn thời gian chơi

## Hoạt Động Thực Hành (65 phút)

### Hoạt động 1: Tạo súng (20 phút)
**Các bước:**
1. Thêm nhân vật "Súng" (hoặc vẽ)
2. Đặt ở vị trí dưới cùng
3. Lập trình di chuyển bằng phím mũi tên
4. Giới hạn di chuyển trong khung hình

**Code:**
```
khi bấm cờ xanh
lặp lại mãi mãi
  nếu phím mũi tên phải được nhấn và x của em < 230 thì
    thay đổi x của em cho 5
  nếu phím mũi tên trái được nhấn và x của em > -230 thì
    thay đổi x của em cho -5
```

### Hoạt động 2: Tạo bong bóng (25 phút)
**Các bước:**
1. Thêm nhân vật "Bong bóng"
2. Đặt vị trí ngẫu nhiên ở dưới
3. Bay lên trên với tốc độ ngẫu nhiên
4. Khi chạm cạnh trên, quay lại dưới

**Code:**
```
khi bấm cờ xanh
lặp lại mãi mãi
  đi tới x: ngẫu nhiên từ -220 đến 220 y: -180
  lặp lại cho đến khi y > 180
    thay đổi y của em cho 2
    đợi 0.05 giây
```

### Hoạt động 3: Bắn và tính điểm (20 phút)
**Các bước:**
1. Thêm nhân vật "Đạn"
2. Khi bấm phím cách, đạn bay lên
3. Kiểm tra chạm bong bóng
4. Nếu chạm: Ẩn bong bóng, tăng điểm

**Code đạn:**
```
khi phím dấu cách được nhấn
hiển thị
lặp lại cho đến khi y > 180 hoặc chạm vào BongBong
  thay đổi y cho 10
nếu chạm vào BongBong thì
  Ẩn BongBong
  thay đổi [Điểm số] cho 1
```

## Bài Tập Về Nhà
- Thêm nhiều bong bóng hơn
- Thêm thời gian giới hạn
- Thêm âm thanh khi bắn trúng
