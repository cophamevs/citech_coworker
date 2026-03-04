# Buổi 24: Dự Án Python - Game Đoán Số

## Thông Tin Buổi Học
- **Độ tuổi**: 10-14 tuổi
- **Thời lượng**: 90 phút
- **Lĩnh vực**: Công nghệ (Lập trình - Game)

## Mục Tiêu Buổi Học
1. Kết hợp tất cả kiến thức đã học
2. Tạo game hoàn chỉnh
3. Phát triển tư duy lập trình

## Nội Dung Lý Thuyết (10 phút)

### Game "Đoán số" nâng cao:
- Người chơi đoán số từ 1-100
- Có giới hạn số lần đoán
- Hiển thị gợi ý "Lớn hơn" / "Nhỏ hơn"
- Đếm số lần đoán

### Cấu trúc chương trình:
1. Tạo số ngẫu nhiên
2. Vòng lặp đoán
3. Kiểm tra điều kiện thắng/thua
4. Thông báo kết quả

## Hoạt Động Thực Hành (70 phút)

### Hoạt động 1: Xây dựng game cơ bản (30 phút)
```python
import random

print("=== GAME ĐOÁN SỐ ===")
print("Tôi đoán một số từ 1 đến 100")
print("Bạn có 7 lần đoán!")

so_may_man = random.randint(1, 100)
so_lan_doan = 0

for i in range(7):
    so_lan_doan += 1
    so = int(input(f"Lần {so_lan_doan}: Nhập số của bạn: "))
    
    if so == so_may_man:
        print(f"Chúc mừng! Bạn đoán đúng sau {so_lan_doan} lần!")
        break
    elif so < so_may_man:
        print("Số của bạn NHỎ hơn. Thử lại!")
    else:
        print("Số của bạn LỚN hơn. Thử lại!")

if so != so_may_man:
    print(f"Hết lần đoán! Số đúng là: {so_may_man}")
```

### Hoạt động 2: Nâng cấp game (25 phút)
```python
import random

print("=== GAME ĐOÁN SỐ NÂNG CAO ===")
print("1. Dễ (1-50)")
print("2. Trung bình (1-100)")
print("3. Khó (1-500)")

chon = input("Chọn cấp độ (1/2/3): ")

if chon == "1":
    max_so = 50
    so_lan = 10
elif chon == "3":
    max_so = 500
    so_lan = 5
else:
    max_so = 100
    so_lan = 7

so_may_man = random.randint(1, max_so)
print(f"Tôi đoán số từ 1-{max_so}")
print(f"Bạn có {so_lan} lần đoán!")

for i in range(so_lan):
    so = int(input(f"Lần {i+1}: "))
    
    if so == so_may_man:
        print(f"THẮNG! Điểm: {100 - (i * 100 // so_lan)}")
        break
    elif so < so_may_man:
        print("↑ Lớn hơn")
    else:
        print("↓ Nhỏ hơn")
else:
    print(f"Thua! Số đúng là: {so_may_man}")
```

### Hoạt động 3: Thử nghiệm và sửa lỗi (15 phút)
- Chạy chương trình
- Tìm và sửa lỗi
- Thêm tính năng mới

## Bài Tập Về Nhà
- Thêm âm thanh (nếu có thể)
- Tạo game "Oẳn tù tì" với máy
