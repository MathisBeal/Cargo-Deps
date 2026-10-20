# cargo-deps README

This is the README for your extension "cargo-deps". After writing up a brief description, we recommend including the following sections.

## Features

Describe specific features of your extension including screenshots of your extension in action. Image paths are relative to this README file.

For example if there is an image subfolder under your extension project workspace:

\!\[feature X\]\(images/feature-x.png\)

> Tip: Many popular extensions utilize animations. This is an excellent way to show off your extension! We recommend short, focused animations that are easy to follow.

## Requirements

If you have any requirements or dependencies, add a section describing those and how to install and configure them.

## Extension Settings

Include if your extension adds any VS Code settings through the `contributes.configuration` extension point.

For example:

This extension contributes the following settings:

- `myExtension.enable`: Enable/disable this extension.
- `myExtension.thing`: Set to `blah` to do something.

## Known Issues

Calling out known issues can help limit users opening duplicate issues against your extension.

## Release Notes

Users appreciate release notes as you update your extension.

### 1.0.0

Initial release of ...

### 1.0.1

Fixed issue #.

### 1.1.0

Added features X, Y, and Z.

# Cargo-Deps

Extension VS Code pour consulter l'etat des dependances Rust directement dans `Cargo.toml`.

## Fonctionnalites

- Inlay hints pour les versions obsoletes et les vulnerabilites RustSec.
- Survol d'une dependance avec sa version installee, la derniere version, les avis de securite, l'historique crates.io et les traces transitives.
- Analyse relancee a l'ouverture et a l'enregistrement de `Cargo.toml`, avec cache pour les reponses crates.io.
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
