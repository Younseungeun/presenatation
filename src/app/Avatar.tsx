// 프로필 아바타 — 사진을 설정하지 않은 계정용 기본 실루엣.
// 예측 카드·팔로우 섹션·프로필이 같은 그림을 쓰도록 한곳에 둔다.
// 사진 업로드가 들어오면 여기만 고치면 전 화면이 따라온다.
export function DefaultAvatar({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} role="img" aria-label="프로필 사진 없음">
      <circle cx="32" cy="24" r="11" fill="currentColor" />
      <path d="M11 60c0-11.6 9.4-21 21-21s21 9.4 21 21z" fill="currentColor" />
    </svg>
  );
}
