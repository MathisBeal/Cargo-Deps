# Cargo-Deps

Extension VS Code pour consulter l'etat des dependances Rust directement dans `Cargo.toml`.

## Fonctionnalites

- Inlay hints pour les versions obsoletes et les vulnerabilites RustSec.
- Survol d'une dependance avec sa version installee, la derniere version, les avis de securite, l'historique crates.io et les traces transitives.
- Liens compacts sous le nom de la dependance : documentation et depot declares sur crates.io, puis page de la crate (avec le vrai nom du package en cas d'alias). Les dependances Git proposent leur depot si son URL est HTTP(S); aucun lien crates.io n'est ajoute pour les sources Git, locales ou privees. Seuls les liens HTTP(S) valides et sans identifiants sont affiches. Les liens reutilisent les metadonnees deja analysees et mises en cache, sans requete supplementaire au survol. Aucun emplacement de changelog n'est devine.
- Analyse automatique de tous les `Cargo.toml` du workspace au demarrage, meme fermes, puis apres sauvegarde, ajout ou suppression d'un manifeste. Les dossiers `target`, `node_modules` et `.git` sont exclus.
- Diagnostics Information pour les mises a jour et Warning pour les avis RustSec, y compris transitifs, dans l'editeur et le panneau Problemes. Les couleurs dependent du theme VS Code; les compteurs de la barre d'etat affichent les erreurs et avertissements, pas necessairement les informations.
- Audit et `cargo outdated --workspace` exécutés une seule fois par workspace pendant chaque scan; les resultats de versions restent associes au bon membre. Les reponses crates.io sont mises en cache et les traces `cargo tree` restent scopees au membre pour ne pas melanger les dependances. Les commandes Cargo ne sont executees que dans un workspace approuve.
- Manifeste racine lu et parse une seule fois par scan; les recherches crates.io, y compris leurs echecs, sont partagees entre les membres. Les echecs sont retentes au scan suivant et les reponses reussies restent en cache pendant 10 minutes. Les requetes HTTP sont limitees a 6 simultanees pour eviter les rafales.
- Les dependances Git, locales et de registres alternatifs ne sont pas recherchees sur crates.io. Leur source est indiquee dans le survol, y compris pour les declarations heritees sous forme de table.
- Indicateur Cargo Deps dans la barre d'etat : spinner pendant l'analyse, manifeste et etape en cours. Le survol affiche une barre textuelle pour les manifestes traites dans le workspace, puis la liste des etapes du manifeste courant avec leur etat et les compteurs de traces et de versions. La barre ne represente pas une estimation de temps et un manifeste traite peut avoir des erreurs. Une fois termine, seul le bilan global reste affiche. Les erreurs sont resumees par un compteur; leurs details, les URL et les informations HTTP/cache restent dans les logs. Pendant un scan, un clic annule l'analyse en cours et en demarre une nouvelle; une fois termine, un clic rafraichit le workspace ou ouvre les logs si l'analyse a des erreurs.
- Canal Output `Cargo Deps` avec les etapes et erreurs completes, accessible via `Cargo Deps: Show Output` et le lien du survol. Les logs sont conserves entre les rafraichissements; ils peuvent contenir des chemins locaux, a verifier avant de les partager.
- Rafraichissement manuel via `Cargo Deps: Refresh Dependency Analysis` dans la palette de commandes.
- Une nouvelle demande de scan remplace immediatement la precedente : decouverte, commandes Cargo et requetes HTTP sont annulees, y compris les requetes en attente. Les resultats partiels publies sont retires ou remplaces par ceux d'avant le scan; les reponses tardives du scan annule sont ignorees. Les reponses crates.io deja terminees restent en cache. Une annulation normale ne declenche pas de notification d'erreur ni de succes.
- Versions cliquables dans le survol (derniere version et historique), et actions rapides par dependance (`Ctrl+.`) pour choisir une version.
- Deux commandes F1 : `Cargo Deps: Update Open Manifests to Latest` pour les `Cargo.toml` ouverts, et `Cargo Deps: Update All Workspace Manifests to Latest` pour tout le workspace.

### Panneau Cargo Deps

L'icone en forme de colis dans la barre d'activite ouvre trois vues natives,
repliables et deplacables comme les autres vues de VS Code :

- **Dependencies** : les dependances directes, dev et build regroupees par crate,
  avec leur version. Les declarations partagees du workspace sont aussi visibles.
  Le survol reprend les informations de l'editeur, y compris les liens de
  documentation/depot et les versions cliquables. Cliquer ouvre le manifeste.
- **Updates** : uniquement les exigences pouvant etre passees a une version plus
  recente. Par defaut, chaque declaration modifiable n'apparait qu'une fois,
  avec le nombre de crates utilisatrices; developper la ligne montre leurs usages.
  Deux declarations independantes d'un meme package restent distinctes.
  Le bouton de filtre configure le perimetre (toutes les crates ou une seule),
  le regroupement (par declaration ou par crate) et les versions proposees.
  Les versions stables sont proposees par defaut; un mode compatible avec
  l'exigence actuelle et un mode incluant les prereleases sont disponibles.
  Le mode compatible utilise les versions deja connues dans l'historique recent.
  Chaque ligne distingue une version compatible, hors plage, prerelease ou de
  compatibilite inconnue, selon les exigences Cargo, y compris les versions `0.x`.
  La fleche met a jour la declaration; celle d'une crate ou de la vue prepare un lot.
  Le bouton de mise a jour individuelle hors plage, prerelease ou de compatibilite inconnue
  demande confirmation; un lot est toujours confirme avec ses types de changements.
- **Security** : les alertes et avertissements groupes par crate, sans repeter
  une meme alerte transitive lorsqu'elle passe par plusieurs dependances.
  Le titre court et la severite sont visibles; les vulnerabilites de gravite
  connue passent en premier, avant les avertissements de maintenance.
  Une severite non determinee reste explicitement inconnue, sans score devine
  a partir d'un vecteur CVSS. L'identifiant technique et les chemins restent au survol.
  Un audit indisponible est signale, jamais presente comme une absence d'alertes.

Les trois vues reutilisent les resultats du scan existant : developper un arbre,
filtrer ou survoler une ligne ne relance ni Cargo ni les recherches crates.io.
Les groupes sont replies par defaut; les compteurs et versions sont discrets,
les actions n'apparaissent qu'au survol des lignes.

Les mises a jour du panneau ne sauvegardent rien et ne modifient pas `Cargo.lock`.
Une dependance heritee est modifiee dans sa vraie declaration
`[workspace.dependencies]`, une seule fois meme si plusieurs membres la partagent.
Le nombre d'utilisateurs et l'arbre des usages gardent tous les membres concernes,
meme avec un filtre sur une seule crate : changer une declaration partagee les affecte tous.
Les modifications non sauvegardees sont repercutees dans le panneau, avec un etat
`pending edits` et les nouvelles exigences marquees `pending`. D'autres dependances
du meme manifeste restent modifiables sans sauvegarder entre chaque action.
Les versions installees et alertes restent celles du dernier scan, comme indique
au survol; sauvegarder relance leur analyse. Les changements de source ne recuperent
pas les anciennes metadonnees d'un package homonyme.
Un TOML temporairement invalide est signale et ses actions sont bloquees jusqu'a
correction. Une modification d'un manifeste concerne ou de son analyse pendant
la confirmation annule l'application du lot entier.

Les mises a jour peuvent changer la version majeure; dans le panneau, les prereleases necessitent le mode explicite. Les versions cliquables du survol et les commandes historiques vers la derniere version conservent leur comportement. Ces actions modifient uniquement les exigences de version, sans sauvegarde automatique ni commande `cargo update` : verifier les changements puis sauvegarder pour relancer l'analyse. Les operateurs simples `^`, `~` et `=` sont conserves; les exigences composees ou avec jokers sont remplacees par la version choisie. Les commentaires, options et autres champs restent inchanges.
Les versions retirees (yanked), les dependances locales, Git et les registres alternatifs ne sont pas modifiables. Une dependance heritee avec `workspace = true` se modifie dans sa declaration `[workspace.dependencies]` du manifeste racine, qui doit etre ouvert pour la commande limitee aux manifestes ouverts. Les mises a jour necessitent un workspace approuve et une analyse disponible; les versions indisponibles sont signalees.

## Prerequis

- Une installation de Rust et Cargo.
- `cargo-audit`, installable avec `cargo install cargo-audit`.
- `cargo-outdated`, installable avec `cargo install cargo-outdated`.
- Un acces reseau a crates.io pour les versions publiees.

L'extension reste active si `cargo-audit` ou `cargo-outdated` est absent et affiche un avertissement avec la commande d'installation.
Un audit indisponible est explicitement indique dans le survol des dependances, sans annoncer une absence de vulnerabilites. Les commandes Cargo interrompues ou en echec ne sont pas considerees comme reussies sur la seule presence d'une sortie partielle.
Les inlay hints sont masques tant que le texte differe de la derniere analyse, pour ne pas afficher d'informations sur des lignes devenues incorrectes. Sauvegarder relance l'analyse. Ouvrir un manifeste deja couvert par un scan en cours ne relance pas un second scan; le rafraichissement manuel signale les erreurs au lieu d'annoncer un succes complet.

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
Les suites `extension` et `updates` utilisent des instances VS Code separees :
le test d'activation ne doit pas lancer de vrais scans Cargo sur les manifestes
temporaires des tests de providers. Pour cibler une suite, utiliser
`pnpm test --label updates` ou `pnpm test --label extension`.

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
