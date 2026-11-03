import { useEffect, useState, useMemo } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import DogGamePage from './pages/DogGame';
import { ToastProvider } from './components/ToastNotification';
import { getDatabaseForUser } from './data/db';
import { setActiveDatabase, DEFAULT_SETTINGS } from './data/repo';
import type { ClassRoom, Student } from './types';

// Danh sách chuẩn 20 học sinh tiểu học Việt Nam
export const ACCEPTANCE_STUDENTS: Array<Omit<Student, 'id' | 'classId' | 'createdAt' | 'updatedAt'>> = [
  { code: 'HS0001', fullName: 'Nguyễn Minh An', gender: 'male', avatar: 'cat-pink', status: 'active' },
  { code: 'HS0002', fullName: 'Trần Thị Thùy Dung', gender: 'female', avatar: 'bunny-pink', status: 'active' },
  { code: 'HS0003', fullName: 'Lê Hoàng Cúc', gender: 'female', avatar: 'bear-cream', status: 'active' },
  { code: 'HS0004', fullName: 'Phạm Gia Khiêm', gender: 'male', avatar: 'puppy-blue', status: 'active' },
  { code: 'HS0005', fullName: 'Đặng Tuấn Tú', gender: 'male', avatar: 'hamster-yellow', status: 'active' },
  { code: 'HS0006', fullName: 'Vũ Bảo Ngọc', gender: 'female', avatar: 'fox-orange', status: 'active' },
  { code: 'HS0007', fullName: 'Bùi Đức Trí', gender: 'male', avatar: 'panda-green', status: 'active' },
  { code: 'HS0008', fullName: 'Đỗ Mai Phương', gender: 'female', avatar: 'deer-purple', status: 'active' },
  { code: 'HS0009', fullName: 'Hồ Quang Huy', gender: 'male', avatar: 'lion-red', status: 'active' },
  { code: 'HS0010', fullName: 'Ngô Khánh Linh', gender: 'female', avatar: 'tiger-teal', status: 'active' },
  { code: 'HS0011', fullName: 'Dương Quốc Bảo', gender: 'male', avatar: 'penguin-cyan', status: 'active' },
  { code: 'HS0012', fullName: 'Lý Thiên Hương', gender: 'female', avatar: 'rabbit-lavender', status: 'active' },
  { code: 'HS0013', fullName: 'Hoàng Minh Quân', gender: 'male', avatar: 'koala-gray', status: 'active' },
  { code: 'HS0014', fullName: 'Chu Ngọc Ánh', gender: 'female', avatar: 'otter-rose', status: 'active' },
  { code: 'HS0015', fullName: 'Phan Trọng Nhân', gender: 'male', avatar: 'elephant-sky', status: 'active' },
  { code: 'HS0016', fullName: 'Trịnh Phương Thảo', gender: 'female', avatar: 'sheep-mint', status: 'active' },
  { code: 'HS0017', fullName: 'Mai Thanh Tùng', gender: 'male', avatar: 'wolf-indigo', status: 'active' },
  { code: 'HS0018', fullName: 'Cao Thùy Chi', gender: 'female', avatar: 'squirrel-amber', status: 'active' },
  { code: 'HS0019', fullName: 'Lương Hữu Phước', gender: 'male', avatar: 'dolphin-cyan', status: 'active' },
  { code: 'HS0020', fullName: 'Tạ Diệu Linh', gender: 'female', avatar: 'butterfly-pink', status: 'active' },
];

const TEST_TEACHER_ID = 'teacher-dog-acceptance-2026';
const TEST_CLASS_ID = 'class-5a-acceptance-uuid';

import { AppContext, type AppState } from './state/AppContext';

function DogGameAcceptanceApp() {
  const [ready, setReady] = useState(false);
  const [currentClass, setCurrentClass] = useState<ClassRoom | null>(null);
  const db = useMemo(() => getDatabaseForUser(TEST_TEACHER_ID), []);

  useEffect(() => {
    async function init() {
      setActiveDatabase(db, TEST_TEACHER_ID);

      // 1. Kiểm tra / Khởi tạo lớp học 5A
      let cls = await db.classes.get(TEST_CLASS_ID);
      if (!cls) {
        cls = {
          id: TEST_CLASS_ID,
          name: 'Lớp 5A',
          schoolYear: '2026-2027',
          teacherName: 'Cô Võ Thùy Tiên',
          color: '#F08DB6',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        await db.classes.put(cls);
      }
      if (cls) {
        setCurrentClass(cls);
      }

      // 2. Khởi tạo 20 học sinh
      const existingStudents = await db.students.where('classId').equals(TEST_CLASS_ID).toArray();
      if (existingStudents.length < 20) {
        await db.students.where('classId').equals(TEST_CLASS_ID).delete();
        for (let i = 0; i < ACCEPTANCE_STUDENTS.length; i++) {
          const s = ACCEPTANCE_STUDENTS[i];
          await db.students.add({
            id: `student-5a-${String(i + 1).padStart(2, '0')}`,
            classId: TEST_CLASS_ID,
            code: s.code,
            fullName: s.fullName,
            gender: s.gender,
            avatar: s.avatar,
            status: 'active',
            createdAt: Date.now() + i * 100,
            updatedAt: Date.now() + i * 100,
          });
        }
      }

      setReady(true);
    }

    init();
  }, [db]);

  const appStateValue: AppState = useMemo(() => {
    return {
      ready,
      classes: currentClass ? [currentClass] : [],
      currentClass,
      setCurrentClassId: () => {},
      settings: DEFAULT_SETTINGS,
      teacherCall: 'cô Tiên',
      db,
      userId: TEST_TEACHER_ID,
    };
  }, [ready, currentClass, db]);

  // Hook tiện ích ghi video Canvas
  useEffect(() => {
    let mediaRecorder: MediaRecorder | null = null;
    let recordedChunks: Blob[] = [];

    // @ts-expect-error test harness
    window.__DOG_TEST_RECORDER__ = {
      start: (fps = 30) => {
        recordedChunks = [];
        const canvas = document.querySelector('canvas');
        if (!canvas) throw new Error('Canvas not found');
        const stream = canvas.captureStream(fps);
        mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9' });
        mediaRecorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) recordedChunks.push(e.data);
        };
        mediaRecorder.start(100);
        console.log('[Recorder] Started recording canvas stream');
      },
      stop: async (): Promise<string> => {
        return new Promise((resolve) => {
          if (!mediaRecorder) {
            resolve('');
            return;
          }
          mediaRecorder.onstop = () => {
            const blob = new Blob(recordedChunks, { type: 'video/webm' });
            const reader = new FileReader();
            reader.onloadend = () => {
              const base64data = reader.result as string;
              console.log('[Recorder] Recording stopped, size:', blob.size, 'bytes');
              resolve(base64data);
            };
            reader.readAsDataURL(blob);
          };
          mediaRecorder.stop();
        });
      },
      isRecording: () => mediaRecorder && mediaRecorder.state === 'recording',
    };
  }, []);

  if (!ready || !currentClass) {
    return (
      <div className="min-h-screen flex items-center justify-center text-ink font-bold">
        Đang khởi tạo 20 học sinh Lớp 5A...
      </div>
    );
  }

  return (
    <AppContext.Provider value={appStateValue}>
      <BrowserRouter>
        <ToastProvider>
          <DogGamePage />
        </ToastProvider>
      </BrowserRouter>
    </AppContext.Provider>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<DogGameAcceptanceApp />);
