import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import LandingPage from './Landing';

describe('Trang chủ giới thiệu TienClass (công khai)', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={['/']}>
      <LandingPage />
    </MemoryRouter>,
  );

  it('hiển thị đầy đủ các khu vực chính', () => {
    expect(html).toContain('Mỗi ngày đến lớp là');
    expect(html).toContain('Thế giới Mini Game');
    expect(html).toContain('Chú chó đuổi bắt');
    expect(html).toContain('Cổng phụ huynh');
    expect(html).toContain('Kết nối yêu thương – Đồng hành trưởng thành');
  });

  it('có đủ các khu vực đích cho menu điều hướng', () => {
    for (const id of ['trang-chu', 'tinh-nang', 'tro-choi', 'phu-huynh', 'gioi-thieu']) {
      expect(html).toContain(`id="${id}"`);
      expect(html).toContain(`href="#${id}"`);
    }
  });

  it('có đủ 6 tiện ích nổi bật và 3 bước bắt đầu', () => {
    for (const t of [
      'Quản lý lớp học',
      'Điểm danh',
      'Điểm thưởng và nề nếp',
      'Nhận xét học sinh',
      'Kết nối phụ huynh',
      'Đồng bộ và an toàn',
      'Đăng nhập tài khoản',
      'Chọn lớp hoặc học sinh',
      'Khám phá tiện ích',
    ]) {
      expect(html).toContain(t);
    }
  });

  it('chỉ dùng hình ảnh game có sẵn trong dự án', () => {
    expect(html).toContain('/assets/landing/schoolyard.webp');
    expect(html).toContain('/assets/game/corgi_run.png');
  });
});
