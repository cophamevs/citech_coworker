# Buổi 21: Python - Điều Kiện và Vòng Lặp

## Thông Tin Buổi Học
- **Độ tuổi**: 10-14 tuổi
- **Thời lượng**: 90 phút
- **Lĩnh vực**: Công nghệ (Lập trình)

## Mục Tiêu Buổi Học
1. Sử dụng câu lệnh điều kiện (if/else)
2. Sử dụng vòng lặp (for, while)
3. Kết hợp để tạo chương trình

## Nội Dung Lý Thuyết (15 phút)

### Câu điều kiện (if/else):
```python
if điều_kiện:
    # làm gì đó
else:
    # làm gì khác
```

### Vòng lặp for:
```python
for i in range(5):
    print(i)  # 0, 1, 2, 3, 4
```

### Vòng lặp while:
```python
while điều_kiện:
    # làm gì đó
```

## Hoạt Động Thực Hành (65 phút)

### Hoạt động 1: Đoán số (25 phút)
```python
import random

so_may_man = random.randint(1, 10)
print("Tôi đoán một số từ 1 đến 10")

so = int(input("Đoán số của tôi: "))

if so == so_may_man:
    print("Chúc mừng! Bạn đoán đúng!")
else:
    print("Sai rồi! Số đúng là:", so_may_man)
```

### Hoạt động 2: Bảng cửu chương (20 phút)
```python
# In bảng nhân 5
for i in range(1, 11):
    print("5 x", i, "=", 5 * i)

# In bảng cửu chương từ 1 đến 9
so = int(input("Nhập số: "))
for i in range(1, 11):
    print(so, "x", i, "=", so * i)
```

### Hoạt động 3: Tính tổng (20 phút)
```python
# Tính tổng từ 1 đến 100
tong = 0
for i in range(1, 101):
    tong = tong + i
print("Tổng 1+2+...+100 =", tong)

# Tính tổng các số chẵn
tong_chan = 0
for i in range(2, 101, 2):
    tong_chan += i
print("Tổng số chẵn =", tong_chan)
```

## Bài Tập Về Nhà
- Viết chương trình kiểm tra số chẵn/lẻ
- In ra tất cả bảng cửu chương
