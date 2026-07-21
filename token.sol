// Rakehellery ($VICE)
// https://x.com/rakehellery
// https://t.me/rakehellery
//
// SPDX-License-Identifier: MIT
pragma solidity ^0.7.6;
pragma abicoder v2;

// Versions are pinned for Solidity 0.7.6 and direct use in Remix.
import 'https://github.com/OpenZeppelin/openzeppelin-contracts/blob/v3.4.2-solc-0.7/contracts/access/Ownable.sol';
import 'https://github.com/OpenZeppelin/openzeppelin-contracts/blob/v3.4.2-solc-0.7/contracts/token/ERC20/ERC20.sol';
import 'https://github.com/Uniswap/v3-core/blob/v1.0.0/contracts/interfaces/IUniswapV3Pool.sol';
import 'https://github.com/Uniswap/v3-core/blob/v1.0.0/contracts/libraries/FixedPoint96.sol';
import 'https://github.com/Uniswap/v3-core/blob/v1.0.0/contracts/libraries/FullMath.sol';
import 'https://github.com/Uniswap/v3-core/blob/v1.0.0/contracts/libraries/TickMath.sol';

// Minimal local interfaces avoid Remix fetching the entire Uniswap V3
// periphery/ERC721 dependency tree.
interface IERC20Metadata {
  function decimals() external view returns (uint8);
}

interface INonfungiblePositionManager {
  struct CollectParams {
    uint256 tokenId;
    address recipient;
    uint128 amount0Max;
    uint128 amount1Max;
  }

  function collect(
    CollectParams calldata params
  ) external payable returns (uint256 amount0, uint256 amount1);

  function transferFrom(address from, address to, uint256 tokenId) external;
}

// Official Uniswap V3 mainnet pool-address derivation.
library PoolAddress {
  bytes32 internal constant POOL_INIT_CODE_HASH =
    0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54;

  struct PoolKey {
    address token0;
    address token1;
    uint24 fee;
  }

  function computeAddress(
    address factory,
    PoolKey memory key
  ) internal pure returns (address pool) {
    require(key.token0 < key.token1, 'Unordered pool tokens');
    pool = address(
      uint256(
        keccak256(
          abi.encodePacked(
            hex'ff',
            factory,
            keccak256(abi.encode(key.token0, key.token1, key.fee)),
            POOL_INIT_CODE_HASH
          )
        )
      )
    );
  }
}

contract Rakehellery is ERC20, Ownable {
  uint8 constant PLAYERS_PER_GAME = 6;
  // Pot split: winner 10/18 (~55.6%), runner-up 3/18 (~16.7%), rest burned (~27.8%)
  // On a $180 table (6 × $30): $100 / $30 / $50 burn
  uint8 constant SHARE_WINNER = 10;
  uint8 constant SHARE_RUNNERUP = 3;
  uint8 constant SHARE_DENOM = 18;
  address constant V3MANAGER = 0xC36442b4a4522E871399CD717aBDD847Ab11FE88;
  address constant V3FACTORY = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
  address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
  address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
  address _creator;
  uint256 _activity;

  bool public gameEnabled = true;
  uint256 public gameCostUSDX96 = 30 * FixedPoint96.Q96; // $30
  uint256 public currentGame;
  // game number => selected wallets (1-PLAYERS_PER_GAME) => player
  mapping(uint256 => mapping(address => address)) public gamePlayers;
  // game number => token cost per game, set when first player selects a game wallet for consistency
  mapping(uint256 => uint256) public gameCostTokens;
  // game number => winning wallet (1-PLAYERS_PER_GAME)
  mapping(uint256 => address) public gameResults;
  // game number => runner-up wallet (1-PLAYERS_PER_GAME)
  mapping(uint256 => address) public gameRunnerUps;
  // game number => user wallet => already entered this game (one entry per wallet)
  mapping(uint256 => mapping(address => bool)) public gameEntered;
  uint256 _currentGamePlayers;
  uint256[] _pendingGameOutcomes;

  event ProcessWinner(
    uint256 indexed _game,
    address indexed _winningSelection,
    address _winner,
    uint256 _amountWon
  );
  event ProcessRunnerUp(
    uint256 indexed _game,
    address indexed _runnerUpSelection,
    address _runnerUp,
    uint256 _amountWon
  );
  event GameWalletSelected(
    uint256 indexed _game,
    address indexed gameWallet,
    address indexed userWallet,
    uint256 _cost
  );

  constructor() ERC20('Rakehellery', 'VICE') {
    _creator = _msgSender();
    _activity = block.timestamp;
    _mint(_creator, 10_000_000_000 * 10 ** 18);
  }

  function _transfer(
    address from,
    address to,
    uint256 amount
  ) internal virtual override {
    _activity = block.timestamp;

    if (gameEnabled) {
      if (_isGameWallet(to)) {
        if (_currentGamePlayers == 0) {
          currentGame++;
          _currentGamePlayers++;
          gamePlayers[currentGame][to] = from;
          gameEntered[currentGame][from] = true;
          gameCostTokens[currentGame] = _getGameCostTokens();
          to = address(0);
          amount = gameCostTokens[currentGame];
          emit GameWalletSelected(currentGame, to, from, amount);
        } else if (
          gamePlayers[currentGame][to] == address(0) &&
          !gameEntered[currentGame][from]
        ) {
          _currentGamePlayers++;
          gamePlayers[currentGame][to] = from;
          gameEntered[currentGame][from] = true;
          to = address(0);
          amount = gameCostTokens[currentGame];
          emit GameWalletSelected(currentGame, to, from, amount);
          if (_currentGamePlayers == PLAYERS_PER_GAME) {
            _pendingGameOutcomes.push(currentGame);
            _currentGamePlayers = 0;
          }
        } else {
          // slot taken or wallet already entered this game, noop transfer
          amount = 0;
        }
      } else if (
        _pendingGameOutcomes.length > 0 && _isProcessableTxn(from, to, amount)
      ) {
        _processGameResult();
      }
    }

    if (to == address(0)) {
      _burn(from, amount);
    } else {
      super._transfer(from, to, amount);
    }
  }

  function _processGameResult() internal {
    uint256 _game = _pendingGameOutcomes[0];
    _pendingGameOutcomes[0] = _pendingGameOutcomes[
      _pendingGameOutcomes.length - 1
    ];
    _pendingGameOutcomes.pop();
    uint256 _resultRaw = uint256(
      keccak256(
        abi.encodePacked(
          block.difficulty,
          block.timestamp,
          _game,
          gameCostTokens[_game],
          _tokenPriceUSDX96(),
          balanceOf(address(_getMainV3Pool())),
          IERC20(USDC).balanceOf(address(_getWETHUSDCV3Pool()))
        )
      )
    );
    uint256 _resultFinal = (_resultRaw % PLAYERS_PER_GAME) + 1;
    // second draw over remaining slots, then shift to skip the winner's index
    uint256 _secondRaw = uint256(
      keccak256(abi.encodePacked(_resultRaw, 'second'))
    );
    uint256 _secondFinal = (_secondRaw % (PLAYERS_PER_GAME - 1)) + 1;
    if (_secondFinal >= _resultFinal) {
      _secondFinal++;
    }

    address _winner = gamePlayers[_game][address(_resultFinal)];
    address _runnerUp = gamePlayers[_game][address(_secondFinal)];
    uint256 _totalPool = gameCostTokens[_game] * PLAYERS_PER_GAME;
    uint256 _winAmount = (_totalPool * SHARE_WINNER) / SHARE_DENOM;
    uint256 _secondAmount = (_totalPool * SHARE_RUNNERUP) / SHARE_DENOM;
    // remaining 5/18 (~27.8%) is not minted (stays burned from entry fees)

    gameResults[_game] = address(_resultFinal);
    gameRunnerUps[_game] = address(_secondFinal);
    _mint(_winner, _winAmount);
    _mint(_runnerUp, _secondAmount);
    emit ProcessWinner(_game, address(_resultFinal), _winner, _winAmount);
    emit ProcessRunnerUp(
      _game,
      address(_secondFinal),
      _runnerUp,
      _secondAmount
    );
  }

  // allows game processing if it's a buy/sell transaction against the main pool
  // of greater than or equal to 2x an entry for a game
  function _isProcessableTxn(
    address _sender,
    address _recipient,
    uint256 _amount
  ) internal view returns (bool) {
    IUniswapV3Pool _mainTokenPool = _getMainV3Pool();
    if (
      _sender == address(_mainTokenPool) ||
      _recipient == address(_mainTokenPool)
    ) {
      return
        (_tokenPriceUSDX96() * _amount) / 10 ** decimals() >=
        2 * gameCostUSDX96;
    }
    return false;
  }

  function _getMainV3Pool() internal view returns (IUniswapV3Pool) {
    return _getV3Pool(address(this), WETH, 10000);
  }

  function _getWETHUSDCV3Pool() internal pure returns (IUniswapV3Pool) {
    return _getV3Pool(WETH, USDC, 500);
  }

  function _isGameWallet(address _wallet) internal pure returns (bool) {
    return _wallet > address(0) && _wallet <= address(PLAYERS_PER_GAME);
  }

  function _getGameCostTokens() internal view returns (uint256) {
    return (gameCostUSDX96 * 10 ** decimals()) / _tokenPriceUSDX96();
  }

  function _tokenPriceUSDX96() internal view returns (uint256) {
    IUniswapV3Pool _wethUSDCPool = _getWETHUSDCV3Pool();
    IUniswapV3Pool _tokenPool = _getMainV3Pool();
    uint256 _usdcWETHPriceX96 = _poolRatioPriceX96(_wethUSDCPool, USDC);
    uint256 _wethTokenPriceX96 = _poolRatioPriceX96(_tokenPool, WETH);
    return (_usdcWETHPriceX96 * _wethTokenPriceX96) / FixedPoint96.Q96;
  }

  function _getV3Pool(
    address _token0,
    address _token1,
    uint24 _fee
  ) internal pure returns (IUniswapV3Pool) {
    (address _t0, address _t1) = _tokensOrdered(_token0, _token1);
    PoolAddress.PoolKey memory _key = PoolAddress.PoolKey({
      token0: _t0,
      token1: _t1,
      fee: _fee
    });
    address pool = PoolAddress.computeAddress(V3FACTORY, _key);
    return IUniswapV3Pool(pool);
  }

  function _poolSqrtPriceX96(address _pool) internal view returns (uint160) {
    uint32 _twapInterval = 5 minutes;
    IUniswapV3Pool _v3Pool = IUniswapV3Pool(_pool);
    uint32[] memory _secAgo = new uint32[](2);
    _secAgo[0] = _twapInterval;
    _secAgo[1] = 0;
    (int56[] memory _tickCums, ) = _v3Pool.observe(_secAgo);
    return
      TickMath.getSqrtRatioAtTick(
        int24((_tickCums[1] - _tickCums[0]) / _twapInterval)
      );
  }

  function _priceX96FromSqrtPriceX96(
    uint160 _sqrtPriceX96
  ) internal pure returns (uint256) {
    return FullMath.mulDiv(_sqrtPriceX96, _sqrtPriceX96, FixedPoint96.Q96);
  }

  function _tokensOrdered(
    address _token0,
    address _token1
  ) internal pure returns (address, address) {
    return _token0 < _token1 ? (_token0, _token1) : (_token1, _token0);
  }

  function _poolRatioPriceX96(
    IUniswapV3Pool _pool,
    address _numerator
  ) internal view returns (uint256) {
    address _t1 = _pool.token1();
    uint8 _decimals0 = IERC20Metadata(_pool.token0()).decimals();
    uint8 _decimals1 = IERC20Metadata(_t1).decimals();
    uint160 _sqrtPriceX96 = _poolSqrtPriceX96(address(_pool));
    uint256 _priceX96 = _priceX96FromSqrtPriceX96(_sqrtPriceX96);
    uint256 _ratiodPriceX96 = _t1 == _numerator
      ? _priceX96
      : FixedPoint96.Q96 ** 2 / _priceX96;
    return
      _t1 == _numerator
        ? (_ratiodPriceX96 * 10 ** _decimals0) / 10 ** _decimals1
        : (_ratiodPriceX96 * 10 ** _decimals1) / 10 ** _decimals0;
  }

  function getGameCostTokens() external view returns (uint256) {
    return _getGameCostTokens();
  }

  function safeTokenPriceUSDX96() external view returns (uint256) {
    return _tokenPriceUSDX96();
  }

  function collectFees(uint256 _tokenId) external {
    INonfungiblePositionManager(V3MANAGER).collect(
      INonfungiblePositionManager.CollectParams({
        tokenId: _tokenId,
        recipient: _creator,
        amount0Max: type(uint128).max,
        amount1Max: type(uint128).max
      })
    );
  }

  // send to creator ONLY after 60 minutes of no token transfers (inactivity)
  function withdrawLP(uint256 _tokenId) external {
    require(block.timestamp > _activity + 60 minutes);
    INonfungiblePositionManager(V3MANAGER).transferFrom(
      address(this),
      _creator,
      _tokenId
    );
  }

  function setGameCostUSDX96(uint256 _newPriceX96) external onlyOwner {
    require(_newPriceX96 > 0);
    gameCostUSDX96 = _newPriceX96;
  }

  function setGameEnabled(bool _is) external onlyOwner {
    require(gameEnabled != _is);
    gameEnabled = _is;
  }
}
