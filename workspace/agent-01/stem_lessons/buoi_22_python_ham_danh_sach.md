# Buổi 22: Python - Hàm và Danh Sách

## Thông Tin Buổi Học
- **Độ tuổi**: 10-14 tuổi
- **Thời lượng**: 90 phút
- **Lĩnh vực**: Công nghệ (Lập trình)

## Mục Tiêu Buổi Học
1. Tạo và sử dụng hàm
2. Hiểu về danh sách (list)
3. Áp dụng vào bài toán thực tế

## Nội Dung Lý Thuyết (15 phút)

### Hàm (Function):
- Đoạn code có thể tái sử dụng
- Đặt tên để gọi lại
- Có thể nhận tham số

```python
def ten_ham(tham_so):
    # làm gì đó
    return gia_tri
```

### Danh sách (List):
- Lưu nhiều giá trị trong 1 biến
- Truy cập bằng chỉ mục (index)

```python
ds = [1, 2, 3, 4, 5]
print(ds[0])  # 1
print(ds[-1]) # 5
```

## Hoạt Động Thực Hành (65 phút)

### Hoạt động 1: Tạo hàm chào (20 phút)
```python
def chao_ho(ten):
    print("Xin chào", ten, "!")
    print("Chào buổi sáng!")

# Gọi hàm
chao_ho("Minh")
chao_ho("Lan")
```

**Bài tập:** Tạo hàm tính bình phương
```python
def binh_phuong(so):
    return so * so

print(binh_phuong(5))  # 25
```

### Hoạt động 2: Làm việc với danh sách (25 phút)
```python
# Tạo danh sách
ten_ban = ["An", "Bình", "Chi", "Dương"]

# In tất cả
for ten in ten_ban:
    print("Xin chào", ten)

# Thêm phần tử
ten_ban.append("Hoa")

# Độ dài danh sách
print("Số bạn:", len(ten_ban))

# Tìm phần tử lớn nhất
diem = [8, 9, 7, 10, 6]
print("Điểm cao nhất:", max(diem))
print("Điểm thấp nhất:", min(diem))
print("Trung bình:", sum(diem) / len(diem))
```

### Hoạt động 3: Ứng dụng danh sách (20 phút)
```python
# Quản lý điểm học sinh
def in_diem(diem_dict):
    for ten, diem in diem_dict.items():
        print(ten, ":", diem)

diem_lop = {
    "Minh": 8,
    "Lan": 9,
    "An": 7,
    "Bình": 10
}

in_diem(diem_lop)

# Tìm điểm trung bình
trung_binh = sum(diem_lop.values()) / len(diem_lop)
print("Điểm TB:", trung_binh)
```

## Bài Tập Về Nhà
- Tạo hàm tính giai thừa
- Tạo danh sách món ăn yêu thích và in ra
