/**
 * from detect-node
 * https://github.com/iliakan/detect-node
 *
 * @property {boolean} IS_NODE - whether running in nodejs but not on electron,node-webkit
 * @global
 * @name IS_NODE
 */
export const IS_NODE = Object.prototype.toString.call(typeof process !== 'undefined' ? process : 0) === '[object process]' && !process.versions['electron'] && !process.versions['nw'] && !process.versions['node-webkit'];

export function getGlobalThis() {
    return typeof globalThis !== 'undefined' ? globalThis : global || self;
}

export function checkMTKVersion(version) {
    const mtkversion = getGlobalThis().maptalksversion;
    // 相同版本重复导入（如打包器对 UMD 的重复 require）应被容忍，
    // 仅在不同版本冲突时抛出错误
    if (mtkversion && mtkversion !== version) {
        throw new Error(`Disallow duplicate imports of maptalks version ${version} and ${mtkversion}`);
    } else {
        getGlobalThis().maptalksversion = version;
    }
}
