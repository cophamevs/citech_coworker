# Buổi 23: Python - Vẽ Hình Với Turtle

## Thông Tin Buổi Học
- **Độ tuổi**: 10-14 tuổi
- **Thời lượng**: 90 phút
- **Lĩnh vực**: Công nghệ (Lập trình - Đồ họa)

## Mục Tiêu Buổi Học
1. Sử dụng thư viện Turtle
2. Vẽ các hình cơ bản
3. Tạo hình phức tạp từ các hình đơn giản

## Nội Dung Lý Thuyết (15 phút)

### Turtle là gì?
- Thư viện đồ họa trong Python
- Điều khiển "con rùa" vẽ trên màn hình
- Rất tốt để học lập trình trực quan

### Các lệnh cơ bản:
```python
import turtle

t = turtle.Turtle()

t.forward(100)  # Đi thẳng 100
t.backward(50) # Lùi 50
t.left(90)      # Quay trái 90 độ
t.right(45)     # Quay phải 45 độ
t.circle(50)    # Vẽ hình tròn bán kính 50
t.penup()       # Nhấc bút (không vẽ)
t.pendown()     # Hạ bút (vẽ tiếp)
```

## Hoạt Động Thực Hành (65 phút)

### Hoạt động 1: Vẽ hình vuông (20 phút)
```python
import turtle

t = turtle.Turtle()

for i in range(4):
    t.forward(100)
    t.right(90)

turtle.done()
```

### Hoạt động 2: Vẽ tam giác và ngũ giác (25 phút)
```python
import turtle

t = turtle.Turtle()

# Tam giác đều
for i in range(3):
    t.forward(100)
    t.left(120)

# Ngũ giác đều
t.penup()
t.forward(150)
t.pendown()

for i in range(5):
    t.forward(80)
    t.left(72)

turtle.done()
```

### Hoạt động 3: Vẽ hoa và patterns (20 phút)
```python
import turtle

t = turtle.Turtle()
t.speed(0)

# Vẽ bông hoa
for i in range(6):
    for j in range(4):
        t.forward(100)
        t.right(90)
    t.right(60)

turtle.done()

# Vẽ vòng tròn xoắn
for i in range(100):
    t.circle(i * 2)
    t.left(5)
```

## Bài Tập Về Nhà
- Vẽ ngôi nhà với mái
- Vẽ một bông hoa sunflower
