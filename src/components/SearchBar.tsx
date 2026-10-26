import { Search, X } from 'lucide-react';

export function SearchBar({
  value,
  onChange,
  placeholder = 'Tìm theo họ tên hoặc mã học sinh...',
  className = '',
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div className={`relative ${className}`}>
      <Search className="w-[18px] h-[18px] text-ink-soft absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
      <input
        className="input pl-10 pr-9"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        type="search"
      />
      {value && (
        <button
          className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 rounded-lg inline-flex items-center justify-center text-ink-soft hover:bg-pink-100"
          onClick={() => onChange('')}
          aria-label="Xóa tìm kiếm"
        >
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}
