// Debauchery ($EXCESS) — Robinhood Chain (chainId 4663)
// Uniswap V3: TOKEN/WETH 1% (10000) + WETH/USDG 0.05% (500) for USD pricing
// https://debauchery.io
// https://x.com/EthExcess
// https://t.me/DebaucheryExcess
//
// SPDX-License-Identifier: MIT
pragma solidity 0.7.6;
pragma abicoder v2;

// Remix: set compiler to 0.7.6 exactly, then deploy contract "Debauchery" (not Ownable/ERC20).
import 'https://github.com/OpenZeppelin/openzeppelin-contracts/blob/v3.4.2-solc-0.7/contracts/access/Ownable.sol';
import 'https://github.com/OpenZeppelin/openzeppelin-contracts/blob/v3.4.2-solc-0.7/contracts/token/ERC20/ERC20.sol';
import 'https://github.com/OpenZeppelin/openzeppelin-contracts/blob/v3.4.2-solc-0.7/contracts/token/ERC20/IERC20.sol';
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

// Uniswap V3 pool-address derivation (same init code hash on Robinhood Chain).
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

contract Debauchery is ERC20, Ownable {
  uint8 constant PLAYERS_PER_GAME = 6;
  uint8 constant PERCENTAGE_WINNER = 60; // 60% to 1st
  uint8 constant PERCENTAGE_RUNNERUP = 20; // 20% to 2nd; remaining 20% stays burned

  // Robinhood Chain Uniswap V3 + canonical tokens
  // https://docs.robinhood.com/chain/contracts/
  address constant V3MANAGER = 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3;
  address constant V3FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
  address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
  address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

  // TOKEN/WETH trading pool: Uniswap V3 1%
  uint24 constant TOKEN_POOL_FEE = 10000;
  // WETH/USDG USD reference pool: 0.05% (deepest reliable TWAP on Robinhood)
  uint24 constant WETH_USDG_FEE = 500;

  address _creator;
  uint256 _activity;

  bool public gameEnabled = true;
  uint256 public gameCostUSDX96 = 25 * FixedPoint96.Q96; // $25
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

  constructor() ERC20('Debauchery', 'EXCESS') Ownable() {
    _creator = _msgSender();
    _activity = block.timestamp;
    _mint(_creator, 10_000_000_000 * 10 ** 18);
  }

  // Game seats must be entered with transfer() so a spender cannot burn
  // more than their allowance via transferFrom (MetaMask scam pattern).
  function transferFrom(
    address sender,
    address recipient,
    uint256 amount
  ) public virtual override returns (bool) {
    require(!_isGameWallet(recipient), 'Game entry requires transfer()');
    return super.transferFrom(sender, recipient, amount);
  }

  function _transfer(
    address from,
    address to,
    uint256 amount
  ) internal virtual override {
    _activity = block.timestamp;

    if (gameEnabled) {
      if (_isGameWallet(to)) {
        // Only the token holder may enter (not a spender via transferFrom).
        require(from == _msgSender(), 'Game entry requires transfer()');
        address gameWallet = to;
        if (_currentGamePlayers == 0) {
          uint256 cost = _getGameCostTokens();
          // Friendly UX: send any amount >= entry; only `cost` is burned.
          // Never burn more than `amount` (keeps MetaMask / allowance safe).
          require(amount >= cost, 'Entry amount too low');
          currentGame++;
          _currentGamePlayers++;
          gamePlayers[currentGame][gameWallet] = from;
          gameEntered[currentGame][from] = true;
          gameCostTokens[currentGame] = cost;
          emit GameWalletSelected(currentGame, gameWallet, from, cost);
          to = address(0);
          amount = cost;
        } else if (
          gamePlayers[currentGame][gameWallet] == address(0) &&
          !gameEntered[currentGame][from]
        ) {
          uint256 cost = gameCostTokens[currentGame];
          require(amount >= cost, 'Entry amount too low');
          _currentGamePlayers++;
          gamePlayers[currentGame][gameWallet] = from;
          gameEntered[currentGame][from] = true;
          emit GameWalletSelected(currentGame, gameWallet, from, cost);
          if (_currentGamePlayers == PLAYERS_PER_GAME) {
            _pendingGameOutcomes.push(currentGame);
            _currentGamePlayers = 0;
          }
          to = address(0);
          amount = cost;
        } else {
          revert('Seat unavailable');
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
          IERC20(USDG).balanceOf(address(_getWETHUSDGV3Pool()))
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
    uint256 _winAmount = (_totalPool * PERCENTAGE_WINNER) / 100;
    uint256 _secondAmount = (_totalPool * PERCENTAGE_RUNNERUP) / 100;
    // remaining 20% is not minted (stays burned from entry fees)

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
    // TOKEN/WETH 1% — create + seed this pool after deploy before enabling gameplay
    return _getV3Pool(address(this), WETH, TOKEN_POOL_FEE);
  }

  function _getWETHUSDGV3Pool() internal pure returns (IUniswapV3Pool) {
    // Canonical WETH/USDG 0.05% pool on Robinhood Chain
    return _getV3Pool(WETH, USDG, WETH_USDG_FEE);
  }

  function _isGameWallet(address _wallet) internal pure returns (bool) {
    return _wallet > address(0) && _wallet <= address(PLAYERS_PER_GAME);
  }

  function _getGameCostTokens() internal view returns (uint256) {
    uint256 _priceX96 = _tokenPriceUSDX96();
    require(_priceX96 > 0, 'No token price');
    return (gameCostUSDX96 * 10 ** decimals()) / _priceX96;
  }

  function _tokenPriceUSDX96() internal view returns (uint256) {
    IUniswapV3Pool _wethUSDGPool = _getWETHUSDGV3Pool();
    IUniswapV3Pool _tokenPool = _getMainV3Pool();
    uint256 _usdgWETHPriceX96 = _poolRatioPriceX96(_wethUSDGPool, USDG);
    uint256 _wethTokenPriceX96 = _poolRatioPriceX96(_tokenPool, WETH);
    return (_usdgWETHPriceX96 * _wethTokenPriceX96) / FixedPoint96.Q96;
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
    // Prefer 5m TWAP; fall back to spot if observations are not ready yet
    try _v3Pool.observe(_secAgo) returns (
      int56[] memory _tickCums,
      uint160[] memory
    ) {
      return
        TickMath.getSqrtRatioAtTick(
          int24((_tickCums[1] - _tickCums[0]) / _twapInterval)
        );
    } catch (bytes memory) {
      (uint160 _sqrtPriceX96, , , , , , ) = _v3Pool.slot0();
      require(_sqrtPriceX96 > 0, 'Pool not initialized');
      return _sqrtPriceX96;
    }
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
    address _t0 = _pool.token0();
    address _t1 = _pool.token1();
    require(_t0 != address(0) && _t1 != address(0), 'Invalid pool');
    uint8 _decimals0 = IERC20Metadata(_t0).decimals();
    uint8 _decimals1 = IERC20Metadata(_t1).decimals();
    uint160 _sqrtPriceX96 = _poolSqrtPriceX96(address(_pool));
    uint256 _priceX96 = _priceX96FromSqrtPriceX96(_sqrtPriceX96);
    require(_priceX96 > 0, 'Bad sqrt price');
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

  function mainPool() external view returns (address) {
    return address(_getMainV3Pool());
  }

  function wethUsdgPool() external pure returns (address) {
    return address(_getWETHUSDGV3Pool());
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
