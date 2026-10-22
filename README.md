# Cockpit : suivi de vos projets sur Plesk

Une page unique qui regroupe, pour chaque projet (sous-domaine) :

- **Surveillance** : en ligne ou non, temps de réponse, historique des dernières vérifications, jours restants du certificat SSL.
- **Déploiement** : dernier commit (ou dernière modification des fichiers).
- **Configuration** : stack, version de Node.js, port, base de données, dépôt, notes. Tout est dans `projects.json`.

Aucune dépendance à installer. Node.js 18 ou plus.

## Installation sur Plesk

1. Créez un sous-domaine, par exemple `cockpit.votre-domaine.fr`, et activez Let's Encrypt.
2. Copiez le contenu de ce dossier dans le répertoire du sous-domaine (gestionnaire de fichiers, FTP ou extension Git).
3. Ouvrez **Node.js** pour ce sous-domaine, puis :
   - activez Node.js (version 18 ou plus) ;
   - **Application Root** : le dossier contenant `server.js` ;
   - **Application Startup File** : `server.js` ;
   - **Custom environment variables** : `ADMIN_USER` et `ADMIN_PASS` (mot de passe long et unique). L'application refuse de démarrer sans elles ;
   - cliquez sur **Enable Node.js**.
4. Éditez `projects.json`, puis redémarrez l'application depuis Plesk.

Ne mettez aucun secret (mots de passe, clés) dans `projects.json` : le contenu s'affiche dans la page.

## projects.json

Champs utiles (tous facultatifs sauf `name` et `url`) :

| Champ | Rôle |
|---|---|
| `name`, `url` | Nom affiché et adresse surveillée |
| `checkUrl` | Adresse à tester si elle diffère de `url` (par exemple une route `/health`) |
| `description`, `notes` | Texte libre |
| `stack`, `node`, `port`, `db`, `repo`, `branch`, `deploy` | Fiche de configuration |
| `pleskUrl` | Lien direct vers le domaine dans Plesk |
| `path` | Dossier du site sur le serveur (pour lire le dernier commit ou la date des fichiers) |
| `gitDir` | Dépôt git à lire à la place de `path` (utile avec l'extension Git de Plesk) |
| `envFile` | Chemin du `.env` du projet (ex. `/var/www/vhosts/dev-asso.fr/regio.dev-asso.fr/.env`) : le cockpit en lit la connexion à la base de données |

Une réponse 401, 403 ou 404 compte comme « en ligne » (le serveur répond). Seules les erreurs 5xx, les délais dépassés et les échecs de connexion comptent comme une panne. Une réponse plus lente que 2 secondes est signalée « lente ».

## Connexion à la base de données

Si `envFile` est renseigné, le cockpit lit ce fichier et affiche dans la fiche : le pilote, l'hôte, le port, le nom de la base, l'utilisateur, et si le serveur de base répond (test TCP, sans authentification). Clés reconnues : `database.default.*` (CodeIgniter 4) et `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` (Node.js). Le mot de passe n'est jamais lu dans le résultat ni envoyé à l'interface. Sans `envFile`, le champ texte `db` est affiché. Le fichier doit être lisible par l'utilisateur système du cockpit (même abonnement Plesk).

## À savoir

- La surveillance fonctionne pour tous les projets, quels que soient leurs abonnements Plesk.
- Les infos de déploiement (`path`, `gitDir`) demandent que l'utilisateur système qui fait tourner le cockpit puisse **lire** ces dossiers. Si vos projets sont dans des abonnements différents, ce n'est pas le cas : placez le cockpit dans le même abonnement, ou laissez ces champs vides.
- Si git signale « dubious ownership », exécutez une fois en SSH : `git config --global --add safe.directory /chemin/du/depot`.
- Le chemin du dépôt géré par l'extension Git de Plesk est indiqué dans l'extension Git du domaine concerné (à vérifier chez vous, il varie selon la version).
- L'historique est conservé dans `data/history.json` (24 h à 5 min d'intervalle). Variable facultative : `CHECK_INTERVAL_SECONDS` (60 minimum).
- Protégez en plus le sous-domaine par un répertoire protégé par mot de passe dans Plesk si vous le souhaitez : c'est une seconde barrière.
