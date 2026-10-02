#!/usr/bin/env python3
"""Build the crash-test mods into testmods/jars/.

Each mod is a few lines of Java compiled against stubs/ (fake Minecraft, Fabric,
Forge and NeoForge classes with the real names), so it references the real game
classes without bundling them. Needs a JDK (javac); targets Java 8 so the same
jars load on every loader from Forge 1.12.2 to NeoForge 1.21.

Jars are written with directory entries: Quilt refuses jars without them
("Failed to create the transform bundle"), real mods always have them.
"""
import json, os, shutil, subprocess, sys, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
JAVAC = os.environ.get('JAVAC', 'javac')
BUILD = os.path.join(HERE, 'build')
JARS = os.path.join(HERE, 'jars')


def javac(out, sources, classpath=None):
    cmd = [JAVAC, '--release', '8', '-Xlint:-options', '-d', out]
    if classpath:
        cmd += ['-cp', classpath]
    subprocess.run(cmd + sources, check=True)


def sources(folder):
    return [os.path.join(r, f) for r, _, fs in os.walk(os.path.join(HERE, folder)) for f in fs if f.endswith('.java')]


def jar(name, outdir, meta):
    with zipfile.ZipFile(os.path.join(JARS, name), 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('META-INF/', '')
        z.writestr('META-INF/MANIFEST.MF', 'Manifest-Version: 1.0\n')
        for root, _, files in os.walk(outdir):
            rel = os.path.relpath(root, outdir)
            if rel != '.':
                z.writestr(rel.replace(os.sep, '/') + '/', '')
            for f in files:
                z.write(os.path.join(root, f), os.path.relpath(os.path.join(root, f), outdir))
        for path, content in meta.items():
            z.writestr(path, content)


def fabric(meta):
    return {'fabric.mod.json': json.dumps({'schemaVersion': 1, 'version': '1.0', **meta})}


def mcmod(modid, name):
    return {'mcmod.info': json.dumps([{'modid': modid, 'name': name, 'version': '1.0', 'mcversion': '1.12.2'}])}


def toml(path, modid, name, dep=None, neo=False):
    t = f'modLoader="javafml"\nloaderVersion="[1,)"\nlicense="MIT"\n[[mods]]\nmodId="{modid}"\nversion="1.0"\ndisplayName="{name}"\n'
    if dep:
        t += f'[[dependencies.{modid}]]\nmodId="{dep}"\n' + ('type="required"\n' if neo else 'mandatory=true\n')
        t += 'versionRange="[1,)"\nordering="NONE"\nside="BOTH"\n'
    return {path: t}


def main():
    shutil.rmtree(BUILD, ignore_errors=True)
    os.makedirs(JARS, exist_ok=True)
    stubs = os.path.join(BUILD, 'stubs')
    javac(stubs, sources('stubs'))
    out = {}
    for mod in ['fabric_provider', 'fabric_cc', 'fabric_dep', 'legacy_cc', 'legacy_dep', 'forge_cc', 'forge_dep', 'neo_cc', 'neo_dep']:
        out[mod] = os.path.join(BUILD, mod)
        javac(out[mod], sources(mod), stubs)
    out['fabric_consumer'] = os.path.join(BUILD, 'fabric_consumer')
    javac(out['fabric_consumer'], sources('fabric_consumer'), stubs + os.pathsep + out['fabric_provider'])

    jar('mstest-fabric-clientcode.jar', out['fabric_cc'], fabric({'id': 'mstest_clientcode', 'name': 'MineShell Test ClientCode', 'environment': '*', 'entrypoints': {'main': ['mstest.ClientCode']}}))
    jar('mstest-fabric-clientapi.jar', out['fabric_provider'], fabric({'id': 'mstest_clientapi', 'name': 'MineShell Test ClientApi', 'environment': 'client'}))
    jar('mstest-fabric-consumer.jar', out['fabric_consumer'], fabric({'id': 'mstest_consumer', 'name': 'MineShell Test Consumer', 'environment': '*', 'entrypoints': {'main': ['mstest.consumer.Main']}}))
    jar('mstest-fabric-needsdep.jar', out['fabric_dep'], fabric({'id': 'mstest_needsdep', 'name': 'MineShell Test NeedsDep', 'environment': '*', 'entrypoints': {'main': ['mstest.dep.Main']}, 'depends': {'mstest_missing': '*'}}))
    jar('mstest-legacy-clientcode.jar', out['legacy_cc'], mcmod('mstest_clientcode', 'MineShell Test ClientCode'))
    jar('mstest-legacy-needsdep.jar', out['legacy_dep'], mcmod('mstest_needsdep', 'MineShell Test NeedsDep'))
    jar('mstest-forge-clientcode.jar', out['forge_cc'], toml('META-INF/mods.toml', 'mstestcc', 'MineShell Test ClientCode'))
    jar('mstest-forge-needsdep.jar', out['forge_dep'], toml('META-INF/mods.toml', 'mstestdep', 'MineShell Test NeedsDep', 'mstest_missing'))
    jar('mstest-neo-clientcode.jar', out['neo_cc'], toml('META-INF/neoforge.mods.toml', 'mstestcc', 'MineShell Test ClientCode', neo=True))
    jar('mstest-neo-needsdep.jar', out['neo_dep'], toml('META-INF/neoforge.mods.toml', 'mstestdep', 'MineShell Test NeedsDep', 'mstest_missing', neo=True))
    shutil.rmtree(BUILD, ignore_errors=True)
    print('\n'.join(sorted(os.listdir(JARS))))


if __name__ == '__main__':
    sys.exit(main())
