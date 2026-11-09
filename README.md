# Coffee Recipe

豆ごとにコーヒーのレシピを記録するWebアプリ。Mac / iPhone / iPad で同期します（Firebase）。

## 構成

| ファイル | 内容 |
|---|---|
| `index.html` / `style.css` / `app.js` | アプリ本体（ビルド不要） |
| `store.js` | 保存処理（Firebase設定済み→Firestore、未設定→この端末のみ） |
| `firebase-config.js` | Firebase の接続設定（**ここを書き換える**） |
| `firestore.rules` | Firestore のセキュリティルール |
| `sw.js` / `manifest.json` / `icons/` | ホーム画面追加・オフライン対応 |

## ローカルで試す

```sh
cd coffee_recipe
python3 -m http.server 8765
# → http://localhost:8765 を開く
```

`firebase-config.js` が未設定の間は「ローカルモード」（そのブラウザだけに保存）で動きます。

## 同期の設定（Firebase）

1. https://console.firebase.google.com で「プロジェクトを作成」（Googleアナリティクスはオフで可）
2. **Authentication** →「始める」→ ログイン方法に **Google** を追加して有効化
3. **Firestore Database** →「データベースを作成」→ ロケーション `asia-northeast1`（東京）→ 本番環境モード
4. Firestore の **ルール** タブに `firestore.rules` の内容を貼り付けて「公開」
5. **プロジェクトの設定**（歯車）→「マイアプリ」→ ウェブ（`</>`）を追加 → 表示された `firebaseConfig` の値を `firebase-config.js` に貼り付け
6. **Authentication → 設定 → 承認済みドメイン** に公開先のドメイン（例: `ユーザー名.github.io`）を追加（`localhost` は最初から入っています）

※ `apiKey` は秘密情報ではありません（公開して問題ない値です）。データはルールで「ログインした本人のみ」読み書きできるよう保護されます。

## 公開（GitHub Pages）

1. GitHub でリポジトリを作成し、このフォルダの中身を push
2. リポジトリの **Settings → Pages** → Source: `Deploy from a branch` / Branch: `main` `/ (root)` → Save
3. 数分後 `https://ユーザー名.github.io/リポジトリ名/` で開けます

## iPhone / iPad で使う

Safari で公開URLを開き、共有ボタン →「ホーム画面に追加」。アプリのように全画面で起動します。
各端末で同じGoogleアカウントでログインすれば同期されます。オフラインでも閲覧・編集でき、接続時に自動で同期されます。

## データ構造（Firestore）

```
users/{uid}/beans/{beanId}     豆: name, origin, producer, station, altitude, process, variety, roast, shop,
                                   roastDate, purchaseDate, price, amount, memo
users/{uid}/recipes/{recipeId} レシピ: beanId, name, dose, ratio, temp, grinder, grind, dripper, filter,
                                   pours[{sec, pct}], totalTime, rating, memo
```

総湯量 = グラム数 × レシオ、各投の湯量 = 総湯量 × 割合(%) で自動計算します。
