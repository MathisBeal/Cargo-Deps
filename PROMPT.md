# Spécifications de l'extension VS Code : `cargo-deps`

## 🎯 Objectif du projet

Développer une extension VS Code en TypeScript (packagée avec `esbuild` et `pnpm`) pour analyser les dépendances d'un projet Rust (`Cargo.toml`). 
L'extension doit afficher l'état de santé des dépendances **directement dans l'éditeur** via des **Inlay Hints** et des **Tooltips au survol (Hover / Markdown)**.

---

## 🛠️ Stack Technique & Outils

| Outil / API | Rôle dans l'extension |
| :--- | :--- |
| **`cargo audit --json`** | Détecter les vulnérabilités de sécurité (RustSec). |
| **`cargo outdated --json`** | Déterminer si une dépendance directe est obsolète et connaître la version cible. |
| **`cargo tree`** | Remonter l'arbre des sous-dépendances (rattacher une vulnérabilité indirecte à une crate du `Cargo.toml`). |
| **API REST `crates.io`** | Récupérer la liste complète et à jour des versions publiées d'une crate (requête HTTP : `https://crates.io/api/v1/crates/{crate_name}`). |
| **VS Code Inlay Hints API** | Afficher le statut de mise à jour / alerte au bout de la ligne dans le `Cargo.toml`. |
| **VS Code Hover API** | Afficher une carte Markdown riche au survol de la version dans le `Cargo.toml`. |

---

## 📌 Fonctionnalités attendues

### 1. Inlay Hints (Affichage inline dans `Cargo.toml`)

Au bout de chaque ligne déclarative de dépendance (ex: `rand = "0.10.3"`), l'extension doit insérer un Inlay Hint :
- Si la version est obsolète : `❌ 0.10.3 -> 0.11.0`
- Si la version présente une vulnérabilité : `⚠️ Vulnérabilité détectée`
- Combinaison possible si les deux conditions sont réunies.

### 2. Tooltip au survol (Hover Provider avec Markdown riche)

Au survol d'une dépendance ou de sa version dans `Cargo.toml`, afficher une fenêtre pop-up formatée en Markdown contenant :

- **Titre & Statut :** Nom de la crate, version installée vs dernière version disponible.
- **Section Vulnérabilités (`cargo audit`) :** Liste des identifiants RUSTSEC, titres et sévérités si applicables.
- **Section Historique des versions (`crates.io`) :** Liste des 5 à 10 dernières versions publiées sur crates.io (en marquant les versions `latest`, `yanked` ou `installée`).
- **Trace de dépendance (`cargo tree`) :** Si la vulnérabilité vient d'une sous-dépendance transitive.

---

## 🏗️ Architecture du Code à implémenter

```text
src/
├── extension.ts        # Point d'entrée, enregistrement des providers
├── services/
│   ├── cargo.ts        # Exécution des commandes CLI (cargo audit, outdated, tree)
│   └── cratesIo.ts     # Client HTTP pour l'API REST de crates.io (fetch + cache)
├── providers/
│   ├── hintsProvider.ts # Implémentation de vscode.InlayHintsProvider
│   └── hoverProvider.ts # Implémentation de vscode.HoverProvider
└── types.ts            # Interfaces TypeScript pour typer les JSONs (Audit, Outdated, Crates.io)
```

---

## ⚠️ Contraintes & Performances

1. **Mise en cache :** Ne PAS relancer `cargo audit` ou les appels `crates.io` à chaque frappe de touche. Mettre en cache les résultats et les rafraîchir uniquement à l'ouverture du fichier, à la sauvegarde (`onDidSaveTextDocument`) ou via une commande dédiée.
2. **Gestion des erreurs :** Si `cargo-audit` ou `cargo-outdated` ne sont pas installés sur la machine de l'utilisateur, l'extension ne doit pas planter mais afficher un message d'avertissement explicite (`vscode.window.showWarningMessage`).
3. **Parsing du `Cargo.toml` :** Utiliser des expressions régulières robustes ou un parser TOML pour extraire correctement `crate_name` et `version` sans fausses détections dans les commentaires.

