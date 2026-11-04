// Firebase のウェブアプリ設定(公開しても問題ない識別情報。アクセス制御は firestore.rules で行う)。
// null にすると、クラウド同期なし(この端末のみ保存)で動作する。
export const firebaseConfig = {
  apiKey: "AIzaSyAqs79Pq1b7qojU9MKcpQgU2G5yD79inoU",
  authDomain: "meneki-saikin-quiz-110417.firebaseapp.com",
  projectId: "meneki-saikin-quiz-110417",
  storageBucket: "meneki-saikin-quiz-110417.firebasestorage.app",
  messagingSenderId: "278418972283",
  appId: "1:278418972283:web:fd468497b81cbf9f338cde"
};
