// 푸시 서비스 워커 — **앱이 닫혀 있어도 이 코드만은 브라우저가 깨워서 실행한다.**
// 그래서 여기 있는 것이 곧 잠금화면에 뜨는 것이고, 여기서 실수하면 알림이 조용히 사라진다.

self.addEventListener('push', (event) => {
  // 본문이 없거나 깨져도 **알림은 반드시 띄운다.** 브라우저는 push 이벤트를 받고도
  // 알림을 안 띄우면 "숨은 푸시"로 보고 경고를 내거나 구독을 끊는다
  let data = { title: '인투빌', body: '새 알림이 있어요', link: '/my/notifications' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch (_) {
    /* 그대로 기본값 */
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      // 링크를 알림에 실어 둔다 — 눌렀을 때 어디로 갈지는 아래 클릭 처리가 읽는다
      data: { link: data.link },
      // 급한 것만 화면을 깨운다. 나머지는 조용히 쌓인다
      requireInteraction: !!data.urgent,
      // 같은 태그면 덮어쓴다 — 알림이 열 개씩 쌓이면 아무도 안 읽는다
      tag: data.urgent ? 'intovill-urgent' : 'intovill',
      renotify: !!data.urgent,
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || '/my/notifications';
  event.waitUntil(
    // **이미 열려 있는 탭이 있으면 그 탭을 쓴다.** 매번 새 창을 열면 탭이 쌓인다
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) {
          c.navigate(link);
          return c.focus();
        }
      }
      return self.clients.openWindow(link);
    }),
  );
});

// 브라우저가 구독을 스스로 갱신하는 경우가 있다. 그때 새 주소를 서버에 알려주지 않으면
// **알림이 조용히 끊긴다** — 사용자는 끊긴 줄도 모른다
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    self.registration.pushManager
      .subscribe(event.oldSubscription ? event.oldSubscription.options : undefined)
      .then((sub) =>
        fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ platform: 'web', token: JSON.stringify(sub) }),
        }),
      )
      .catch(() => {
        /* 다음에 앱을 열면 등록 화면이 다시 시도한다 */
      }),
  );
});
