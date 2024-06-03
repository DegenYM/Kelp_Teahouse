
export type OutputDataSchemaRow = {
    block_number: number;
    timestamp: number;
    user_address: string;
    token_address: string;
    token_balance: bigint;
    token_symbol: string; //token symbol should be empty string if it is not available
    in_active: boolean;
};

export type UserShareTokenBalance = {
    user: string;
    block_number: number;
    contractId: string;        
    balance: bigint,
}

export type UserShareTokenBalanceWithActiveTag = {
    block_number: number;
    timestamp: number;
    user_address: string;
    contractId: string;        
    balance: bigint,
    isActive: boolean;
}

export interface BlockData {
    blockNumber: number;
    blockTimestamp: number;
  }
  
export interface UserTokenAmounts {
    [user: string]: {
        [token: string]: bigint;
    };
}

export interface TokenSymbol {
    [tokenAddress: string]: string;
}
