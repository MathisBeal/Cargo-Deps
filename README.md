# Cargo-Deps

Extension VS Code pour consulter l'etat des dependances Rust directement dans `Cargo.toml`.

## Fonctionnalites

- Inlay hints pour les versions obsoletes et les vulnerabilites RustSec.
- Survol d'une dependance avec sa version installee, la derniere version, les avis de securite, l'historique crates.io et les traces transitives.
- Analyse automatique de tous les `Cargo.toml` du workspace au demarrage, meme fermes, puis apres sauvegarde, ajout ou suppression d'un manifeste. Les dossiers `target`, `node_modules` et `.git` sont exclus.
- Diagnostics Information pour les mises a jour et Warning pour les avis RustSec, y compris transitifs, dans l'editeur et le panneau Problemes. Les couleurs dependent du theme VS Code; les compteurs de la barre d'etat affichent les erreurs et avertissements, pas necessairement les informations.
- Audit partage par workspace pendant chaque scan et cache pour les reponses crates.io. Les commandes Cargo ne sont executees que dans un workspace approuve.
- Rafraichissement manuel via `Cargo Deps: Refresh Dependency Analysis` dans la palette de commandes.

## Prerequis

- Une installation de Rust et Cargo.
- `cargo-audit`, installable avec `cargo install cargo-audit`.
- `cargo-outdated`, installable avec `cargo install cargo-outdated`.
- Un acces reseau a crates.io pour les versions publiees.

L'extension reste active si `cargo-audit` ou `cargo-outdated` est absent et affiche un avertissement avec la commande d'installation.

## Developpement

```sh
pnpm install
pnpm run compile
pnpm test
```
