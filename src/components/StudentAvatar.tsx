import type { Student } from '../types';
import { AnimalAvatarSVG } from './avatars';

export function StudentAvatar({
  student,
  size = 44,
  rounded = 'xl',
  ring,
}: {
  student: Pick<Student, 'avatar' | 'fullName'>;
  size?: number;
  rounded?: 'full' | 'xl';
  ring?: boolean;
}) {
  return (
    <span
      className={`inline-flex shrink-0 overflow-hidden ${rounded === 'full' ? 'rounded-full' : 'rounded-[30%]'} ${ring ? 'ring-4 ring-pink-300' : ''}`}
      style={{ width: size, height: size }}
      title={student.fullName}
    >
      <AnimalAvatarSVG avatarKey={student.avatar} size={size} />
    </span>
  );
}
