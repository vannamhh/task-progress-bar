# Progress Bar Sidebar cho Obsidian

Plugin này hiển thị thanh tiến độ trực quan cho các công việc trong tệp Markdown của bạn ngay trên sidebar của Obsidian.


## Tính năng

- 📊 **Hiển thị thanh tiến độ trực quan** cho các công việc trong tệp hiện tại
- 🔢 **Hiển thị tỉ lệ phần trăm hoàn thành** và số lượng công việc đã hoàn thành 
- ⚡ **Cập nhật theo thời gian thực** khi bạn tích hoặc bỏ tích các công việc
- 📱 **Hoạt động trong mọi chế độ xem** (chế độ chỉnh sửa và chế độ đọc)
- 🎨 **Tùy chỉnh** màu sắc và chiều cao của thanh tiến độ

## Cài đặt

### Cài đặt từ Community Plugins

1. Mở Obsidian
2. Vào Settings (Cài đặt) > Community plugins (Plugin cộng đồng)
3. Tắt Safe Mode (Chế độ an toàn) nếu đang bật
4. Nhấn "Browse" (Duyệt) và tìm kiếm "Progress Bar Sidebar"
5. Cài đặt plugin và kích hoạt

### Cài đặt thủ công

1. Tạo thư mục `progress-bar-sidebar` trong `.obsidian/plugins/`
2. Sao chép tất cả các tệp của plugin vào thư mục đó
3. Khởi động lại Obsidian và kích hoạt plugin trong Settings > Community plugins

## Cách sử dụng

1. Nhấp vào biểu tượng biểu đồ thanh trong sidebar hoặc sử dụng lệnh "Show Task Progress Bar" 
2. Mở một tệp Markdown có chứa danh sách công việc
3. Thanh tiến độ sẽ tự động hiển thị tỉ lệ hoàn thành của các công việc

Plugin tự động theo dõi các thay đổi trong tệp và cập nhật thanh tiến trình khi bạn tích hoặc bỏ tích các công việc, cả trong chế độ chỉnh sửa và chế độ đọc.

### Cú pháp công việc được hỗ trợ

Plugin hỗ trợ cú pháp công việc chuẩn của Markdown và Obsidian:

```markdown
- [ ] Công việc chưa hoàn thành
- [x] Công việc đã hoàn thành
- [X] Cũng là công việc đã hoàn thành
- [/] Công việc đang thực hiện
- [-] Công việc đã hủy
- [>] Công việc đã hoãn lại
```

## Khắc phục sự cố

Nếu progress bar không hiển thị chính xác trong Reading View, vui lòng đợi vài giây để plugin tự động đồng bộ trạng thái. Plugin đã được thiết kế để tự động phát hiện và sửa lỗi không nhất quán giữa giao diện và nội dung file.

