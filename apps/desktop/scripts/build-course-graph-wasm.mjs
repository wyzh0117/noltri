import {execFileSync} from 'node:child_process';
import {copyFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const graph=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../src/workbench/course-workspace/graph');
execFileSync('cargo',['build','--manifest-path',path.join(graph,'force-wasm/Cargo.toml'),'--release','--target','wasm32-unknown-unknown'],{stdio:'inherit'});
copyFileSync(path.join(graph,'force-wasm/target/wasm32-unknown-unknown/release/noltri_course_force.wasm'),path.join(graph,'graph-force.wasm'));
