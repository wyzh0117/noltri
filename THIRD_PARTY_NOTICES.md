# Third-party notices

Noltri uses third-party software under its respective licenses. This notice does not grant a license to Noltri's own source code; the project has not yet declared its own license.

The desktop runtime builder pins and checksum-verifies the official Node.js archive. It copies the archive's complete LICENSE text, including bundled third-party notices, to `apps/desktop/src-tauri/resources/node-LICENSE.txt` and includes that file in the application resources. Keep that file with binary distributions.

Other components include Tauri and its official plugins, Rust crates recorded in Cargo.lock, and JavaScript dependencies recorded in pnpm-lock.yaml (including React, CodeMirror, markdown-it, KaTeX, Mermaid and DOMPurify). Their licenses and copyright notices remain those supplied by their upstream distributions. Dependency license collection must be reviewed against the final distributable; this short index is not a complete transitive license inventory.

No repository-wide license is inferred from any dependency's license or from the repository being public.

The public desktop build also verifies `apps/desktop/licenses/third-party-notices.tar.gz` and materializes its reviewed license texts, dependency index and corresponding-source references into `resources/third-party`. The manifest binds the bundle to both dependency locks and verifies every extracted file. Lock changes stop the build until the notice bundle is refreshed and reviewed against the updated dependencies; do not update only the checksum to bypass that review. The bundle is a conservative production dependency superset and retains original upstream notices. It contains no user data or internal build paths.
