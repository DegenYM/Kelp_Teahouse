import { promisify } from 'util';
import stream from 'stream';
import csv from 'csv-parser';
import * as fs from "fs";
import { write } from "fast-csv";
import { ethers } from 'ethers';
import ABI_JSON from "./sdk/v3pair_abi.json";
import { client } from "./sdk/config";
import { VAULT_ADDRESS } from "./sdk/vaults";
import { 
  BlockData, 
  UserShareTokenBalanceWithActiveTag,
  OutputDataSchemaRow, 
  UserTokenAmounts, 
  TokenSymbol
} from './sdk/types';
import {
  getTimestampAtBlock,
  getPoolInfoByBlock, 
  getVaultsAllPositionsByBlock, 
  getAmountsForLiquidityByBlock, 
  getUsersShareTokenBalancesByBlock,
} from "./sdk/lib";
import { wrap } from 'module';
import { exit } from 'process';

const ERC20abi = ["function symbol() view returns (string)"];
const provider = new ethers.JsonRpcProvider(client.transport.url);
const vault_ABI = ABI_JSON;
const pipeline = promisify(stream.pipeline);

const readBlocksFromCSV = async (filePath: string): Promise<number[]> => {
    const blocks: number[] = [];
    await pipeline(
        fs.createReadStream(filePath),
        csv(),
        async function* (source) {
            for await (const chunk of source) {
                // Assuming each row in the CSV has a column 'block' with the block number
                if (chunk.block) blocks.push(parseInt(chunk.block, 10));
            }
        }
    );
    return blocks;
};
const initializeAmounts = (userAddress: string, token0: string, token1: string, amounts: any) => {
  if (!amounts[userAddress]) {
      amounts[userAddress] = {};
  }
  if (!amounts[userAddress][token0]) {
      amounts[userAddress][token0] = 0n;
  }
  if (!amounts[userAddress][token1]) {
      amounts[userAddress][token1] = 0n;
  }
};

// Add token amounts to the user
const addToAmounts = (userAddress: string, token0: string, token1: string, activeAmount: bigint, inactiveAmount: bigint, amounts: any) => {
  amounts[userAddress][token0] += activeAmount;
  amounts[userAddress][token1] += inactiveAmount;
};

const getData = async () => {
  const blocks = [
    5128059
  ]; //await readBlocksFromCSV('src/sdk/mode_chain_daily_blocks.csv');

  const csvRows: OutputDataSchemaRow[] = [];

  for (const block of blocks) {
      const timestamp = await getTimestampAtBlock(block)
      csvRows.push(...await getUserTVLByBlock({ blockNumber: block, blockTimestamp: timestamp }))
  }

  // Write the CSV output to a file
  const ws = fs.createWriteStream('outputData.csv');
  write(csvRows, { headers: true }).pipe(ws).on('finish', () => {
      console.log("User TVL file has been written.");
  });
};

export const getUserTVLByBlock = async ({ blockNumber, blockTimestamp }: BlockData): Promise<OutputDataSchemaRow[]> => {
  const result: OutputDataSchemaRow[] = []
  const activeAmounts: UserTokenAmounts = {};
  const inactiveAmounts: UserTokenAmounts = {};
  const symbols: TokenSymbol = {};

  const shareTokenData: UserShareTokenBalanceWithActiveTag[] = []; 
  const userShareTokenBalances = await getUsersShareTokenBalancesByBlock(blockNumber);

  if(userShareTokenBalances) {
    for (const userBalance of userShareTokenBalances) {
      const rowData: UserShareTokenBalanceWithActiveTag = {
        block_number: userBalance.block_number,
        timestamp: blockTimestamp,
        user_address: userBalance.user,
        contractId: userBalance.contractId,
        balance: BigInt(userBalance.balance.toString()),
        isActive: true,
      };
      shareTokenData.push(rowData);
    }  
  }

  const ws = fs.createWriteStream('shareToken.csv');
  write(shareTokenData, { headers: true }).pipe(ws).on('finish', () => {
      console.log("Share token file has been written.");
  });

  // console.log('User share token balances:', userShareTokenBalances);
  for (const vaultAddress of VAULT_ADDRESS) {
    try {
      const contract = new ethers.Contract(vaultAddress, vault_ABI, provider);
      console.log("Processing vault:", vaultAddress);
      
      // Step 1: Get vault in-range positions by block
      const positionsByBlock = await getVaultsAllPositionsByBlock(contract, blockNumber);

      // Step 2: Get pool info by block
      const poolInfo = await getPoolInfoByBlock(contract, blockNumber);

      // Step 3: Filter positions within the pool tick range
      const activePositions = positionsByBlock.filter(
        position => position.tickLower <= poolInfo.tick && position.tickUpper > poolInfo.tick
      );
      const inactivePositions = positionsByBlock.filter(
        position => position.tickLower > poolInfo.tick || position.tickUpper <= poolInfo.tick
      );
      // console.log('Active positions:', activePositions);
      // console.log('Inactive positions:', inactivePositions);

      if (activePositions.length === 0) {
        console.log("No in-range positions found for this vault:", vaultAddress);
        continue;
      }
      if (inactivePositions.length === 0) {
        console.log("No out-of-range positions found for this vault:", vaultAddress);
      }

      // Step 4: Get ratio of active and inactive liquidity  
      let activeLiquidity = 0n;
      let inactiveLiquidity = 0n;

      for (const position of activePositions) {
        activeLiquidity += position.liquidity;
      }
      for (const position of inactivePositions) {
        inactiveLiquidity += position.liquidity;
      }
      const totalLiquidity = activeLiquidity + inactiveLiquidity;

      // Step 5: Separate the balances for each user based on the active and inactive liquidity
      for (const userBalance of shareTokenData) {
        if(userBalance.contractId.toLowerCase() === vaultAddress.toLowerCase() && userBalance.balance > 0n) {
          const activeBalance = (userBalance.balance * activeLiquidity) / totalLiquidity;
          const inactiveBalance = userBalance.balance - activeBalance;

          // Replace the original data to reflect the active and inactive balances, and adding a column with tag inActive (0 or 1)
          userBalance.balance = activeBalance;
          if (inactiveBalance !== 0n) { 
            // Add the inactive balance as a new row
            const inactiveRow: UserShareTokenBalanceWithActiveTag = {
              user_address: userBalance.user_address,
              block_number: userBalance.block_number,
              timestamp: blockTimestamp,
              contractId: userBalance.contractId,
              balance: inactiveBalance,
              isActive: false,
            };
            shareTokenData.push(inactiveRow);
          }
        }
      }

      // Step 6: Get vault token amounts for the active and inactive liquidity
      let totalActiveAmount0 = 0n;
      let totalActiveAmount1 = 0n;
      let totalInactiveAmount0 = 0n;
      let totalInactiveAmount1 = 0n;

      for (const position of activePositions) {
        const { amount0, amount1 } = await getAmountsForLiquidityByBlock(
          contract,
          position.tickLower,
          position.tickUpper,
          position.liquidity,
          blockNumber
        );
        totalActiveAmount0 += BigInt(amount0.toString());
        totalActiveAmount1 += BigInt(amount1.toString());
      }

      for (const position of inactivePositions) {
        const { amount0, amount1 } = await getAmountsForLiquidityByBlock(
          contract,
          position.tickLower,
          position.tickUpper,
          position.liquidity,
          blockNumber
        );
        totalInactiveAmount0 += BigInt(amount0.toString());
        totalInactiveAmount1 += BigInt(amount1.toString());
      }
      
      // Step 7: Get token symbols for token0 and token1 
      if (!symbols[poolInfo.token0]) {
        const token0 = new ethers.Contract(poolInfo.token0, ERC20abi, provider);
        const token0Symbol = await token0.symbol();
        symbols[poolInfo.token0] = token0Symbol;
      }
      if (!symbols[poolInfo.token1]) {
        const token1 = new ethers.Contract(poolInfo.token1, ERC20abi, provider);
        const token1Symbol = await token1.symbol();
        symbols[poolInfo.token1] = token1Symbol;
      }

      // Step 8: Get total supply of share token by block
      const totalSupplyByBlock = await contract.totalSupply({ blockTag: blockNumber });
      // console.log('Total supply by block:', totalSupplyByBlock);
      
      // Step 9: Iterate over user share token balances and calculate token amounts
      if (shareTokenData) {
        for (const userBalance of shareTokenData) {
          // console.log("Processing user balance:", userBalance);
          if (userBalance.contractId.toLowerCase() === vaultAddress.toLowerCase() && userBalance.balance > 0n) {
            // Calculate token0 and token1 amounts based on the share ratio
            const activeToken0Amount: bigint = userBalance.balance * totalActiveAmount0 / totalSupplyByBlock;
            const activeToken1Amount: bigint = userBalance.balance * totalActiveAmount1 / totalSupplyByBlock;
            const inactiveToken0Amount: bigint = userBalance.balance * totalInactiveAmount0 / totalSupplyByBlock;
            const inactiveToken1Amount: bigint = userBalance.balance * totalInactiveAmount0 / totalSupplyByBlock;
                    
            initializeAmounts(userBalance.user_address, poolInfo.token0, poolInfo.token1, activeAmounts);
            initializeAmounts(userBalance.user_address, poolInfo.token0, poolInfo.token1, inactiveAmounts);

            addToAmounts(userBalance.user_address, poolInfo.token0, poolInfo.token1, activeToken0Amount, activeToken1Amount, activeAmounts);
            addToAmounts(userBalance.user_address, poolInfo.token0, poolInfo.token1, inactiveToken0Amount, inactiveToken1Amount, inactiveAmounts);
          }
        }
      } else {
        console.error("usersShareTokenBalances is null.");
      }
    } catch (error) {
      console.error("Error processing vault:", vaultAddress, error);
    }
  }

  shareTokenData.forEach((data) => {
    const {block_number, timestamp, user_address, contractId, balance, isActive} = data;
    const userActiveTokenAmounts = activeAmounts[user_address];
    const userInactiveTokenAmounts = inactiveAmounts[user_address];
    for (const token in userActiveTokenAmounts) {
      const amount = userActiveTokenAmounts[token];      
      // Create an OutputDataSchemaRow for the current user
      const rowData: OutputDataSchemaRow = {
        block_number: block_number,
        timestamp: blockTimestamp,
        user_address: user_address,
        token_address: token, // Placeholder for token address
        token_balance: amount, // Placeholder for token balance
        token_symbol: symbols[token], // Placeholder for token symbol
        in_active: true,
      };
      result.push(rowData);
    }

    for (const token in userInactiveTokenAmounts) {
      const amount = userInactiveTokenAmounts[token];      
      // Create an OutputDataSchemaRow for the current user
      if (amount === 0n) continue;
      const rowData: OutputDataSchemaRow = {
        block_number: block_number,
        timestamp: blockTimestamp,
        user_address: user_address,
        token_address: token, // Placeholder for token address
        token_balance: amount, // Placeholder for token balance
        token_symbol: symbols[token], // Placeholder for token symbol
        in_active: false,
      };
      result.push(rowData);
    }
  });
  return result;
};

getData().then(() => {
  console.log("Done");
});
