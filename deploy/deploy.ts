// deploy/deploy.ts
import fs from "fs";
import path from "path";
import { ethers as hardhatEthers } from "hardhat";
import { Wallet } from "ethers";

async function main() {
  // --- 1. 定义文件路径 ---
  // 私钥文件路径 (与此脚本同目录)
  const privateKeysFile = path.join(__dirname, "sy.txt");
  // CSV 输出文件路径 (与此脚本同目录)
  const outputFile = path.join(__dirname, "bushu.csv");

  // --- 2. 读取私钥 ---
  if (!fs.existsSync(privateKeysFile)) {
    console.error(`错误：未在 ${privateKeysFile} 找到私钥文件`);
    process.exit(1);
  }

  const privateKeys = fs
    .readFileSync(privateKeysFile, "utf8")
    .split("\n")
    .map((k) => k.trim())
    .filter((k) => k.length > 0); // 过滤掉空行

  if (privateKeys.length === 0) {
    console.error(`在 ${privateKeysFile} 中未找到任何私钥`);
    process.exit(1);
  }

  console.log(`找到 ${privateKeys.length} 个私钥，准备开始批量部署...`);

  // --- 3. 准备 CSV 文件 ---
  const csvHeader = "DeployerAddress,ContractAddress\n";
  // 写入表头 (覆盖旧文件)
  fs.writeFileSync(outputFile, csvHeader);
  console.log(`部署结果将保存到: ${outputFile}`);

  // --- 4. 批量部署 ---
  // 从 hardhat.config.ts 获取当前 --network 标志指定的 provider
  const provider = hardhatEthers.provider;
  const UniversalAdapterFactoryBase =
    await hardhatEthers.getContractFactory("UniversalAdapter");

  for (const privateKey of privateKeys) {
    let wallet: Wallet | undefined;
    try {
      // 使用当前 provider 连接钱包
      wallet = new Wallet(privateKey, provider);
      console.log(`\n[${privateKeys.indexOf(privateKey) + 1}/${privateKeys.length}] 正在使用地址部署: ${wallet.address}`);

      // 将 factory 连接到当前的钱包
      const factory = UniversalAdapterFactoryBase.connect(wallet);

      // 部署合约
      const contract = await factory.deploy();
      await contract.waitForDeployment();

      // 兼容 ethers v5 (address) 和 v6 (target)
      const deployedAddress = (contract as any).target || (contract as any).address;
      console.log(`  -> 成功! 合约地址: ${deployedAddress}`);

      // 将结果追加到 CSV
      const csvLine = `${wallet.address},${deployedAddress}\n`;
      fs.appendFileSync(outputFile, csvLine);

    } catch (error) {
      const deployerAddress = wallet ? wallet.address : "InvalidKey";
      // 格式化错误信息以安全存入 CSV
      const errorMessage = (error as Error).message.replace(/\n/g, " ").replace(/,/g, ";");
      
      console.error(`  -> 失败! 地址: ${deployerAddress}. 错误:`, (error as Error).message);
      
      // 在 CSV 中记录错误
      const csvErrorLine = `${deployerAddress},"Error: ${errorMessage}"\n`;
      fs.appendFileSync(outputFile, csvErrorLine);
    }
  }

  console.log("\n--- 批量部署完成 ---");

  // --- 5. 复制 ABI 到前端 (此操作与部署次数无关，执行一次即可) ---
  const frontendConfigDir = path.join(__dirname, "..", "frontend", "web", "src");
  if (!fs.existsSync(frontendConfigDir)) {
    console.warn("未找到前端 src 目录，跳过 ABI 复制:", frontendConfigDir);
  } else {
    try {
      const artifactPath = path.join(
        __dirname,
        "..",
        "artifacts",
        "contracts",
        "UniversalAdapter.sol",
        "UniversalAdapter.json"
      );
      const targetAbiPath = path.join(frontendConfigDir, "abi");
      if (!fs.existsSync(targetAbiPath)) fs.mkdirSync(targetAbiPath, { recursive: true });
      fs.copyFileSync(artifactPath, path.join(targetAbiPath, "UniversalAdapter.json"));
      console.log("已复制 ABI 到 frontend/web/src/abi/UniversalAdapter.json");
    } catch (e) {
      console.warn(
        "自动复制 ABI 失败。请手动复制 artifacts/.../UniversalAdapter.json 到 frontend/web/src/abi/",
        e
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});