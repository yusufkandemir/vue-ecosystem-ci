import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { execaCommand } from 'execa'
import {
	EnvironmentData,
	Overrides,
	ProcessEnv,
	RepoOptions,
	RunOptions,
	Task,
} from './types'
import { REGISTRY_ADDRESS, startRegistry } from './registry'
//eslint-disable-next-line n/no-unpublished-import
import { detect, AGENTS, Agent, getCommand } from '@antfu/ni'
import actionsCore from '@actions/core'

const isGitHubActions = !!process.env.GITHUB_ACTIONS

let vuePath: string
let cwd: string
let env: ProcessEnv

function cd(dir: string) {
	cwd = path.resolve(cwd, dir)
}

export async function $(literals: TemplateStringsArray, ...values: any[]) {
	const cmd = literals.reduce(
		(result, current, i) =>
			result + current + (values?.[i] != null ? `${values[i]}` : ''),
		'',
	)

	if (isGitHubActions) {
		actionsCore.startGroup(`${cwd} $> ${cmd}`)
	} else {
		console.log(`${cwd} $> ${cmd}`)
	}

	const proc = execaCommand(cmd, {
		env,
		stdio: 'pipe',
		cwd,
	})
	proc.stdin && process.stdin.pipe(proc.stdin)
	proc.stdout && proc.stdout.pipe(process.stdout)
	proc.stderr && proc.stderr.pipe(process.stderr)
	const result = await proc

	if (isGitHubActions) {
		actionsCore.endGroup()
	}

	return result.stdout
}

let app: any
export async function setupEnvironment(): Promise<EnvironmentData> {
	app = await startRegistry()

	// @ts-expect-error import.meta
	const root = dirnameFrom(import.meta.url)
	const workspace = path.resolve(root, 'workspace')
	vuePath = path.resolve(workspace, 'core')
	cwd = process.cwd()
	env = {
		...process.env,
		CI: 'true',
		ECOSYSTEM_CI: 'vue', // for downstream packages to detect
		TURBO_FORCE: 'true', // disable turbo caching, ecosystem-ci modifies things and we don't want replays
		YARN_ENABLE_IMMUTABLE_INSTALLS: 'false', // to avoid errors with mutated lockfile due to overrides
		NODE_OPTIONS: '--max-old-space-size=6144', // GITHUB CI has 7GB max, stay below
	}
	return { root, workspace, vuePath, cwd, env }
}

export async function teardownEnvironment() {
	app.close(() => process.exit(0))
}

export async function setupRepo(options: RepoOptions) {
	if (options.branch == null) {
		options.branch = 'main'
	}
	if (options.shallow == null) {
		options.shallow = true
	}

	let { repo, commit, branch, tag, dir, shallow } = options
	if (!dir) {
		throw new Error('setupRepo must be called with options.dir')
	}
	if (!repo.includes(':')) {
		repo = `https://github.com/${repo}.git`
	}

	let needClone = true
	if (fs.existsSync(dir)) {
		const _cwd = cwd
		cd(dir)
		let currentClonedRepo: string | undefined
		try {
			currentClonedRepo = await $`git ls-remote --get-url`
		} catch {
			// when not a git repo
		}
		cd(_cwd)

		if (repo === currentClonedRepo) {
			needClone = false
		} else {
			fs.rmSync(dir, { recursive: true, force: true })
		}
	}

	if (needClone) {
		await $`git -c advice.detachedHead=false clone ${
			shallow ? '--depth=1 --no-tags' : ''
		} --branch ${tag || branch} ${repo} ${dir}`
	}
	cd(dir)
	await $`git clean -fdxq`
	await $`git fetch ${shallow ? '--depth=1 --no-tags' : '--tags'} origin ${
		tag ? `tag ${tag}` : `${commit || branch}`
	}`
	if (shallow) {
		await $`git -c advice.detachedHead=false checkout ${
			tag ? `tags/${tag}` : `${commit || branch}`
		}`
	} else {
		await $`git checkout ${branch}`
		await $`git merge FETCH_HEAD`
		if (tag || commit) {
			await $`git reset --hard ${tag || commit}`
		}
	}
}

function toCommand(
	task: Task | Task[] | void,
	agent: Agent,
): ((scripts: any) => Promise<any>) | void {
	return async (scripts: any) => {
		const tasks = Array.isArray(task) ? task : [task]
		for (const task of tasks) {
			if (task == null || task === '') {
				continue
			} else if (typeof task === 'string') {
				const scriptOrBin = task.trim().split(/\s+/)[0]
				if (scripts?.[scriptOrBin] != null) {
					const runTaskWithAgent = getCommand(agent, 'run', [task])
					await $`${runTaskWithAgent}`
				} else {
					await $`${task}`
				}
			} else if (typeof task === 'function') {
				await task()
			} else {
				throw new Error(
					`invalid task, expected string or function but got ${typeof task}: ${task}`,
				)
			}
		}
	}
}

export async function runInRepo(options: RunOptions & RepoOptions) {
	if (options.verify == null) {
		options.verify = true
	}
	if (options.skipGit == null) {
		options.skipGit = false
	}
	if (options.branch == null) {
		options.branch = 'main'
	}
	const {
		build,
		test,
		repo,
		branch,
		tag,
		commit,
		skipGit,
		verify,
		beforeInstall,
		beforeBuild,
		beforeTest,
	} = options
	const dir = path.resolve(
		options.workspace,
		options.dir || repo.substring(repo.lastIndexOf('/') + 1),
	)

	if (!skipGit) {
		await setupRepo({ repo, dir, branch, tag, commit })
	} else {
		cd(dir)
	}

	if (options.agent == null) {
		const detectedAgent = await detect({ autoInstall: false })
		if (detectedAgent == null) {
			throw new Error(`Failed to detect packagemanager in ${dir}`)
		}
		options.agent = detectedAgent
	}
	if (!AGENTS[options.agent]) {
		throw new Error(
			`Invalid agent ${options.agent}. Allowed values: ${Object.keys(
				AGENTS,
			).join(', ')}`,
		)
	}
	const agent = options.agent
	const beforeInstallCommand = toCommand(beforeInstall, agent)
	const beforeBuildCommand = toCommand(beforeBuild, agent)
	const beforeTestCommand = toCommand(beforeTest, agent)
	const buildCommand = toCommand(build, agent)
	const testCommand = toCommand(test, agent)

	const pkgFile = path.join(dir, 'package.json')
	const pkg = JSON.parse(await fs.promises.readFile(pkgFile, 'utf-8'))

	await beforeInstallCommand?.(pkg.scripts)

	if (verify && test) {
		const frozenInstall = getCommand(agent, 'frozen')
		await $`${frozenInstall}`
		await beforeBuildCommand?.(pkg.scripts)
		await buildCommand?.(pkg.scripts)
		await beforeTestCommand?.(pkg.scripts)
		await testCommand?.(pkg.scripts)
	}
	const overrides = options.overrides || {}

	const vuePackages = await getVuePackages()

	if (options.release) {
		for (const pkg of vuePackages) {
			if (overrides[pkg.name] && overrides[pkg.name] !== options.release) {
				throw new Error(
					`conflicting overrides[${pkg.name}]=${
						overrides[pkg.name]
					} and --release=${
						options.release
					} config. Use either one or the other`,
				)
			} else {
				overrides[pkg.name] = options.release
			}
		}
	} else {
		for (const pkg of vuePackages) {
			overrides[pkg.name] ||= pkg.hashedVersion
		}
	}
	await applyPackageOverrides(dir, pkg, overrides)
	await beforeBuildCommand?.(pkg.scripts)
	await buildCommand?.(pkg.scripts)
	if (test) {
		await beforeTestCommand?.(pkg.scripts)
		await testCommand?.(pkg.scripts)
	}
	return { dir }
}

export async function setupVueRepo(options: Partial<RepoOptions>) {
	const repo = options.repo || 'vuejs/core'
	await setupRepo({
		repo,
		dir: vuePath,
		branch: 'main',
		shallow: true,
		...options,
	})
}

export async function getPermanentRef() {
	const _cwd = cwd
	cd(vuePath)
	try {
		const ref = await $`git log -1 --pretty=format:%h`
		return ref
	} catch (e) {
		console.warn(`Failed to obtain perm ref. ${e}`)
		return undefined
	} finally {
		cd(_cwd)
	}
}

// FIXME: when running the first time and with `--release` option, the directory would be empty
export async function getVuePackages() {
	// append the hash of the current commit to the version to avoid conflicts
	const commitHash = await getPermanentRef()

	return (
		fs
			.readdirSync(`${vuePath}/packages`)
			// filter out non-directories
			.filter((name) =>
				fs.statSync(`${vuePath}/packages/${name}`).isDirectory(),
			)
			// parse package.json
			.map((name) => {
				const directory = `${vuePath}/packages/${name}`
				const packageJson = JSON.parse(
					fs.readFileSync(`${directory}/package.json`, 'utf-8'),
				)
				return {
					directory,
					packageJson,
				}
			})
			// filter out packages that has `"private": true` in `package.json`
			.filter(({ packageJson }) => {
				return !packageJson.private
			})
			.map(({ packageJson, directory }) => ({
				name: packageJson.name,
				version: packageJson.version,
				// if `build-vue` and `run-suites` are run separately, the version would already include commit hash
				hashedVersion: packageJson.version.includes(commitHash)
					? packageJson.version
					: `${packageJson.version}-${commitHash}`,
				directory: directory,
			}))
	)
}

function writeOrAppendNpmrc(dir: string, content: string) {
	const npmrcPath = path.join(dir, '.npmrc')
	if (fs.existsSync(npmrcPath)) {
		fs.appendFileSync(npmrcPath, `\n${content}`)
	} else {
		fs.writeFileSync(npmrcPath, content)
	}
}

export async function buildVue({ verify = false, publish = false }) {
	const packages = await getVuePackages()

	// TODO: it's better to update the release script in the core repo than hacking it here
	for (const pkg of packages) {
		cd(pkg.directory)

		// update buildOptions to remove browser builds to speed up builds
		const packageJsonPath = path.join(pkg.directory, 'package.json')
		const packageJson = JSON.parse(
			await fs.promises.readFile(packageJsonPath, 'utf-8'),
		)
		if (Array.isArray(packageJson.buildOptions?.formats)) {
			packageJson.buildOptions.formats =
				packageJson.buildOptions.formats.filter(
					(f: string) => !f.includes('browser') && !f.includes('global'),
				)
		}

		await fs.promises.writeFile(
			packageJsonPath,
			JSON.stringify(packageJson, null, 2) + '\n',
			'utf-8',
		)
	}

	cd(vuePath)
	const install = getCommand('pnpm', 'install')
	const runBuild = getCommand('pnpm', 'run', ['build', '--release'])
	const runBuildDts = getCommand('pnpm', 'run', ['build-dts'])
	const runTest = getCommand('pnpm', 'run', ['test'])
	// Prefix with `corepack` because pnpm 7 & 8's lockfile formats differ
	await $`corepack ${install}`
	await $`${runBuild}`
	await $`${runBuildDts}`

	if (verify) {
		await $`${runTest}`
	}

	if (publish) {
		// TODO: prompt for `pnpm clean` if the same version already exists
		// TODO: it's better to update the release script in the core repo than hacking it here
		for (const pkg of packages) {
			cd(pkg.directory)

			// sync versions
			const packageJsonPath = path.join(pkg.directory, 'package.json')
			const packageJson = JSON.parse(
				await fs.promises.readFile(packageJsonPath, 'utf-8'),
			)
			packageJson.version = pkg.hashedVersion
			for (const dep of packages) {
				if (packageJson.dependencies?.[dep.name]) {
					packageJson.dependencies[dep.name] = dep.hashedVersion
				}
				if (packageJson.devDependencies?.[dep.name]) {
					packageJson.devDependencies[dep.name] = dep.hashedVersion
				}
				if (packageJson.peerDependencies?.[dep.name]) {
					packageJson.peerDependencies[dep.name] = dep.hashedVersion
				}
			}
			await fs.promises.writeFile(
				packageJsonPath,
				JSON.stringify(packageJson, null, 2) + '\n',
				'utf-8',
			)

			writeOrAppendNpmrc(
				pkg.directory,
				`${REGISTRY_ADDRESS.replace('http://', '//')}:_authToken=dummy`,
			)
			await $`pnpm publish --access public --registry ${REGISTRY_ADDRESS} --no-git-checks`
		}
	}
}

export async function bisectVue(
	good: string,
	runSuite: () => Promise<Error | void>,
) {
	// sometimes vue build modifies files in git, e.g. LICENSE.md
	// this would stop bisect, so to reset those changes
	const resetChanges = async () => $`git reset --hard HEAD`

	try {
		cd(vuePath)
		await resetChanges()
		await $`git bisect start`
		await $`git bisect bad`
		await $`git bisect good ${good}`
		let bisecting = true
		while (bisecting) {
			const commitMsg = await $`git log -1 --format=%s`
			const isNonCodeCommit = commitMsg.match(/^(?:release|docs)[:(]/)
			if (isNonCodeCommit) {
				await $`git bisect skip`
				continue // see if next commit can be skipped too
			}
			const error = await runSuite()
			cd(vuePath)
			await resetChanges()
			const bisectOut = await $`git bisect ${error ? 'bad' : 'good'}`
			bisecting = bisectOut.substring(0, 10).toLowerCase() === 'bisecting:' // as long as git prints 'bisecting: ' there are more revisions to test
		}
	} catch (e) {
		console.log('error while bisecting', e)
	} finally {
		try {
			cd(vuePath)
			await $`git bisect reset`
		} catch (e) {
			console.log('Error while resetting bisect', e)
		}
	}
}

function isLocalOverride(v: string): boolean {
	if (!v.includes('/') || v.startsWith('@')) {
		// not path-like (either a version number or a package name)
		return false
	}
	try {
		return !!fs.lstatSync(v)?.isDirectory()
	} catch (e) {
		if (e.code !== 'ENOENT') {
			throw e
		}
		return false
	}
}
export async function applyPackageOverrides(
	dir: string,
	pkg: any,
	overrides: Overrides = {},
) {
	const useFileProtocol = (v: string) =>
		isLocalOverride(v) ? `file:${path.resolve(v)}` : v
	// remove boolean flags
	overrides = Object.fromEntries(
		Object.entries(overrides)
			//eslint-disable-next-line @typescript-eslint/no-unused-vars
			.filter(([key, value]) => typeof value === 'string')
			.map(([key, value]) => [key, useFileProtocol(value as string)]),
	)
	await $`git clean -fdxq` // remove current install

	const agent = await detect({ cwd: dir, autoInstall: false })

	// Remove version from agent string:
	// yarn@berry => yarn
	// pnpm@6, pnpm@7 => pnpm
	const pm = agent?.split('@')[0]

	if (pm === 'pnpm') {
		const version = await $`pnpm --version`
		// avoid bug with absolute overrides in pnpm 7.18.0
		if (version === '7.18.0') {
			console.warn(
				'detected pnpm@7.18.0, changing pkg.packageManager and pkg.engines.pnpm to enforce use of pnpm@7.18.1',
			)
			// corepack reads this and uses pnpm 7.18.1 then
			pkg.packageManager = 'pnpm@7.18.1'
			if (!pkg.engines) {
				pkg.engines = {}
			}
			pkg.engines.pnpm = '7.18.1'
		}
		// if (!pkg.devDependencies) {
		// 	pkg.devDependencies = {}
		// }
		// pkg.devDependencies = {
		// 	...pkg.devDependencies,
		// 	...overrides, // overrides must be present in devDependencies or dependencies otherwise they may not work
		// }
		if (!pkg.pnpm) {
			pkg.pnpm = {}
		}
		pkg.pnpm.overrides = {
			...pkg.pnpm.overrides,
			...overrides,
		}
	} else if (pm === 'yarn') {
		pkg.resolutions = {
			...pkg.resolutions,
			...overrides,
		}
	} else if (pm === 'npm') {
		pkg.overrides = {
			...pkg.overrides,
			...overrides,
		}
		// npm does not allow overriding direct dependencies, force it by updating the blocks themselves
		for (const [name, version] of Object.entries(overrides)) {
			if (pkg.dependencies?.[name]) {
				pkg.dependencies[name] = version
			}
			if (pkg.devDependencies?.[name]) {
				pkg.devDependencies[name] = version
			}
		}
	} else {
		throw new Error(`unsupported package manager detected: ${pm}`)
	}
	const pkgFile = path.join(dir, 'package.json')
	await fs.promises.writeFile(
		pkgFile,
		JSON.stringify(pkg, null, 2) + '\n',
		'utf-8',
	)

	// use of `ni` command here could cause lockfile violation errors so fall back to native commands that avoid these
	if (pm === 'pnpm') {
		// FIXME: write/append to npmrc instead
		await $`pnpm install --no-frozen-lockfile --no-strict-peer-dependencies --registry ${REGISTRY_ADDRESS}`
	} else if (pm === 'yarn') {
		await $`yarn install --registry ${REGISTRY_ADDRESS}`
	} else if (pm === 'npm') {
		await $`npm install --registry ${REGISTRY_ADDRESS}`
	}
}

export function dirnameFrom(url: string) {
	return path.dirname(fileURLToPath(url))
}

export function parseVueMajor(vuePath: string): number {
	const content = fs.readFileSync(
		path.join(vuePath, 'packages', 'vue', 'package.json'),
		'utf-8',
	)
	const pkg = JSON.parse(content)
	return parseMajorVersion(pkg.version)
}

export function parseMajorVersion(version: string) {
	return parseInt(version.split('.', 1)[0], 10)
}
