# 免疫・細菌学 演習アプリ

iPhone / iPad で使える演習アプリ(PWA)。基礎免疫学・細菌学の予想問題と過去問を、ブラウザだけで解けます。成績は Firebase(Firestore)に保存され、ユーザー間で比較できます。

## 機能
- ユーザー選択(ユーザー1〜8、名前変更可)
- 予想問題: 全問ランダム / 章ごと、以前の続きから(回答済みはスキップ)/ 初めから / 間違えた問題の復習
- 不正解の問題は、あと2回正解すると「正解扱い」
- 過去問演習: 科目 → 年度 → 回答する → 解答と解説(記述式は非掲載)
- 成績比較(正解扱い数・正答率・初回正解率・章別・過去問)
- オフラインでも動作(送信待ちの記録は復帰後に同期)

## 構成
- `docs/` … 公開サイト(GitHub Pages)。`docs/data/*.json` が問題データ
- `firestore.rules` / `firebase.json` … Firebase CLI でデプロイ
- `docs/firebase-config.js` … ウェブアプリ設定

## デプロイ
```sh
npx firebase-tools deploy --only firestore   # ルール反映
git push                                      # docs/ が GitHub Pages に反映
```
iPhone/iPad は Safari で開き、共有ボタン →「ホーム画面に追加」でアプリのように使えます。

## 注意
Firestore のルールは、成績データ(`progress`, `profiles`)を誰でも読み書きできる設定です(ID 形式と項目のみ制限)。身内で使う前提です。
