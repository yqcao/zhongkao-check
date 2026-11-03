// 站点配置。默认不联网：成绩保存在本机，并生成“成绩码”通过微信发给家长。
// 部署了 cloud/scf 云函数（腾讯云国际站，香港）之后，填写下面两项即可自动同步：
//   url  云函数的函数 URL
//   key  学生上传口令，与云函数环境变量 WRITE_KEY 相同（家长密码不要写在这里）
window.ZK_CONFIG = {
  cloud: { url: "https://1524734921-lyi1qirwex.ap-hongkong.tencentscf.com", key: "wk-9b17cdcd16ad1d69" },
};
