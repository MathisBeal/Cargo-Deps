# Cargo-Deps

Extension VS Code pour consulter l'etat des dependances Rust directement dans `Cargo.toml`.

## Fonctionnalites

- Inlay hints pour les versions obsoletes et les vulnerabilites RustSec.
- Survol d'une dependance avec sa version installee, la derniere version, les avis de securite, l'historique crates.io et les traces transitives.
- Analyse automatique de tous les `Cargo.toml` du workspace au demarrage, meme fermes, puis apres sauvegarde, ajout ou suppression d'un manifeste. Les dossiers `target`, `node_modules` et `.git` sont exclus.
- Diagnostics Information pour les mises a jour et Warning pour les avis RustSec, y compris transitifs, dans l'editeur et le panneau Problemes. Les couleurs dependent du theme VS Code; les compteurs de la barre d'etat affichent les erreurs et avertissements, pas necessairement les informations.
- Audit partage par workspace pendant chaque scan et cache pour les reponses crates.io. Les commandes Cargo ne sont executees que dans un workspace approuve.
- Indicateur Cargo Deps dans la barre d'etat : spinner pendant l'analyse, manifeste et etape en cours. Le survol detaille les etapes paralleles, terminees ou ignorees, les crates et URL actives, les compteurs HTTP et cache, et les erreurs eventuelles. Un clic relance le rafraichissement du workspace, ou ouvre les logs si l'analyse a des erreurs.
- Canal Output `Cargo Deps` avec les etapes et erreurs completes, accessible via `Cargo Deps: Show Output` et le lien du survol. Les logs sont conserves entre les rafraichissements; ils peuvent contenir des chemins locaux, a verifier avant de les partager.
- Rafraichissement manuel via `Cargo Deps: Refresh Dependency Analysis` dans la palette de commandes.
- Versions cliquables dans le survol (derniere version et historique), et actions rapides par dependance (`Ctrl+.`) pour choisir une version.
- Deux commandes F1 : `Cargo Deps: Update Open Manifests to Latest` pour les `Cargo.toml` ouverts, et `Cargo Deps: Update All Workspace Manifests to Latest` pour tout le workspace.

Les mises a jour peuvent changer la version majeure ou choisir une prerelease si elle est indiquee comme derniere version. Elles modifient uniquement les exigences de version, sans sauvegarde automatique ni commande `cargo update` : verifier les changements puis sauvegarder pour relancer l'analyse. Les operateurs simples `^`, `~` et `=` sont conserves; les exigences composees ou avec jokers sont remplacees par la version choisie. Les commentaires, options et autres champs restent inchanges.
Les versions retirees (yanked), les dependances locales, Git et les registres alternatifs ne sont pas modifiables. Une dependance heritee avec `workspace = true` se modifie dans sa declaration `[workspace.dependencies]` du manifeste racine, qui doit etre ouvert pour la commande limitee aux manifestes ouverts. Les mises a jour necessitent un workspace approuve et une analyse disponible; les versions indisponibles sont signalees.

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

Node.js 24 et la version de pnpm indiquee dans `package.json` sont utilises en CI.
Les tests lancent une instance de VS Code; sous Linux sans affichage, utiliser
`xvfb-run -a pnpm test`. Cargo doit etre disponible pour le test d'integration
des workspaces.

## CI et releases

- Chaque PR et chaque push sur `develop` verifient le typage TypeScript, ESLint,
  les outils de release et la creation d'un VSIX de production. Les tests de
  l'extension tournent dans VS Code sur Linux, Windows et macOS.
- Le VSIX est aussi disponible dans l'artefact `extension-vsix` du run Actions
  pendant 14 jours, y compris pour les PR.
- Chaque push sur `main` (merge de PR ou push direct) relance tous les controles
  puis cree une release GitHub avec le tag `v<version>`, la date UTC, les notes
  extraites du changelog, un lien vers le diff depuis la version precedente,
  le VSIX teste et son empreinte SHA-256. Le tag pointe sur le commit exact du run.
- Aucune publication automatique sur le Marketplace et aucun PAT ne sont
  necessaires : telecharger le VSIX depuis la release pour le publier manuellement.
  Seul le job de publication dispose du droit `contents: write`.

### Preparer une PR vers main

1. Augmenter `version` dans `package.json` avec une version stable
   `majeure.mineure.correctif`, strictement superieure aux tags `v*` existants.
2. Deplacer les notes de `## Unreleased` sous un nouveau titre `## <version>`
   dans `CHANGELOG.md`. Cette section doit etre la premiere section versionnee,
   unique et non vide; `Unreleased` peut rester present, mais vide.
3. Verifier localement :

   ```sh
   git fetch origin --tags
   pnpm run test:release
   pnpm run release:check --new-version
   pnpm run package:vsix
   ```

Par exemple, apres `v0.1.0`, preparer `"version": "0.1.1"` et une section
`## 0.1.1` contenant les changements a publier. La CI d'une PR vers `main`
refuse une version deja taguee, un retour de version ou des notes restees dans
`Unreleased`. Les PR vers `develop` peuvent conserver la version courante.
La date est ajoutee lors de la publication, sans modifier les sources.

### Configuration GitHub

Dans les regles de protection de `main` et `develop`, rendre le check
`CI required` obligatoire et interdire les pushes directs/force-pushes sur
`main`. Un workflow seul ne peut pas imposer ces regles de protection.
Autoriser egalement GitHub Actions dans les parametres du depot.

En cas d'echec transitoire avant publication, relancer le workflow `Release`
avec **Run workflow**, en selectionnant `main`, ou relancer le run en echec.
Une version deja taguee est volontairement refusee : les releases publiees
ne sont ni ecrasees ni remplacees. Un echec de publication doit etre verifie
avant toute nouvelle tentative si un tag ou une release a deja ete cree.
Les actions sont epinglees par SHA et Dependabot propose leur mise a jour
hebdomadaire vers `develop`.
