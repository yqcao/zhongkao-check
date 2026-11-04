// 站点配置。默认不联网：成绩保存在本机，并生成“成绩码”通过微信发给家长。
// 部署了 cloud/scf 云函数（腾讯云国际站，香港）之后，填写下面两项即可自动同步：
//   url  云函数的函数 URL
//   key  学生上传口令，与云函数环境变量 WRITE_KEY 相同（家长密码不要写在这里）
// resetAt（毫秒时间戳）：这个时间之前的成绩全部作废，各设备打开网站时自动清空本机旧记录。要再清一次，改成新的时间即可。
window.ZK_CONFIG = {
  resetAt: 1793753190193, // 2026-11-03 19:46（美东）
  cloud: { url: "https://1524734921-lyi1qirwex.ap-hongkong.tencentscf.com", key: "wk-9b17cdcd16ad1d69" },
};
