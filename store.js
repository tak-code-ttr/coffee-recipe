// データ保存層。Firebase 設定済みなら Firestore（端末間同期）、未設定なら localStorage。
import { firebaseConfig } from './firebase-config.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';

export const isCloud = !!(firebaseConfig && firebaseConfig.apiKey &&
  !String(firebaseConfig.apiKey).startsWith('YOUR_'));

export function createBackend() {
  return isCloud ? createCloud() : createLocal();
}

// Firestore は undefined を受け付けないので JSON 経由で除去する
const clean = (o) => JSON.parse(JSON.stringify(o));

const randomId = () =>
  (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Date.now().toString(36) + Math.random().toString(36).slice(2)).slice(0, 20);

/* ---------- ローカルモード ---------- */
function createLocal() {
  const KEY = 'coffee-recipe-local-v1';
  let listeners = [];
  let data;
  try { data = JSON.parse(localStorage.getItem(KEY)) || null; } catch { data = null; }
  if (!data) data = { beans: {}, recipes: {} };

  const snapshot = () => ({ beans: Object.values(data.beans), recipes: Object.values(data.recipes) });
  const emit = () => { const s = snapshot(); listeners.forEach((f) => f(s)); };
  const persist = () => {
    try { localStorage.setItem(KEY, JSON.stringify(data)); }
    catch (e) { alert('この端末への保存に失敗しました: ' + e.message); }
    emit();
  };

  return {
    mode: 'local',
    watchUser(cb) { cb({ uid: 'local', displayName: 'この端末のみ（ローカルモード）' }); },
    async login() {},
    async logout() {},
    subscribe(_uid, cb) {
      listeners.push(cb);
      cb(snapshot());
      return () => { listeners = listeners.filter((f) => f !== cb); };
    },
    newId: randomId,
    async save(kind, obj) { data[kind][obj.id] = clean(obj); persist(); },
    async remove(kind, id) { delete data[kind][id]; persist(); },
  };
}

/* ---------- Firebase モード ---------- */
async function createCloud() {
  const [appM, authM, fs] = await Promise.all([
    import(SDK + 'firebase-app.js'),
    import(SDK + 'firebase-auth.js'),
    import(SDK + 'firebase-firestore.js'),
  ]);
  const app = appM.initializeApp(firebaseConfig);
  const auth = authM.getAuth(app);
  let db;
  try {
    // オフラインでも閲覧・編集でき、つながったら自動で同期される
    db = fs.initializeFirestore(app, {
      localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }),
    });
  } catch {
    db = fs.getFirestore(app);
  }
  authM.getRedirectResult(auth).catch((e) => console.warn(e));

  let uid = null;
  const ref = (kind, id) => fs.doc(db, 'users', uid, kind, id);

  return {
    mode: 'cloud',
    watchUser(cb) {
      authM.onAuthStateChanged(auth, (u) => {
        uid = u ? u.uid : null;
        cb(u ? { uid: u.uid, displayName: u.displayName, email: u.email } : null);
      });
    },
    async login() {
      const provider = new authM.GoogleAuthProvider();
      try {
        await authM.signInWithPopup(auth, provider);
      } catch (e) {
        const fallback = ['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment', 'auth/web-storage-unsupported'];
        if (fallback.includes(e.code)) await authM.signInWithRedirect(auth, provider);
        else if (e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') throw e;
      }
    },
    logout: () => authM.signOut(auth),
    subscribe(userId, cb) {
      let beans = null, recipes = null;
      const emit = () => { if (beans && recipes) cb({ beans, recipes }); };
      const onErr = (e) => alert('同期エラー: ' + e.message);
      const u1 = fs.onSnapshot(fs.collection(db, 'users', userId, 'beans'),
        (s) => { beans = s.docs.map((d) => ({ ...d.data(), id: d.id })); emit(); }, onErr);
      const u2 = fs.onSnapshot(fs.collection(db, 'users', userId, 'recipes'),
        (s) => { recipes = s.docs.map((d) => ({ ...d.data(), id: d.id })); emit(); }, onErr);
      return () => { u1(); u2(); };
    },
    newId: randomId,
    save: (kind, obj) => fs.setDoc(ref(kind, obj.id), clean(obj)),
    remove: (kind, id) => fs.deleteDoc(ref(kind, id)),
  };
}
