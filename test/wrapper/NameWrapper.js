const { ethers } = require('hardhat')
const { use, expect } = require('chai')
const { solidity } = require('ethereum-waffle')
const { labelhash, namehash, encodeName, FUSES } = require('../test-utils/ens')
const { evm } = require('../test-utils')
const { shouldBehaveLikeERC1155 } = require('./ERC1155.behaviour')
const { shouldSupportInterfaces } = require('./SupportsInterface.behaviour')
const { shouldRespectConstraints } = require('./Constraints.behaviour')
const { ZERO_ADDRESS } = require('@openzeppelin/test-helpers/src/constants')
const { deploy } = require('../test-utils/contracts')
const { EMPTY_BYTES32, EMPTY_ADDRESS } = require('../test-utils/constants')

const abiCoder = new ethers.utils.AbiCoder()

use(solidity)

const ROOT_NODE = EMPTY_BYTES32

const DUMMY_ADDRESS = '0x0000000000000000000000000000000000000001'
const DAY = 86400
const GRACE_PERIOD = 90 * DAY

function increaseTime(delay) {
  return ethers.provider.send('evm_increaseTime', [delay])
}

function mine() {
  return ethers.provider.send('evm_mine')
}

const {
  CANNOT_UNWRAP,
  CANNOT_BURN_FUSES,
  CANNOT_TRANSFER,
  CANNOT_SET_RESOLVER,
  CANNOT_SET_TTL,
  CANNOT_CREATE_SUBDOMAIN,
  PARENT_CANNOT_CONTROL,
  CAN_DO_EVERYTHING,
  IS_DOT_ETH,
} = FUSES

describe('Name Wrapper', () => {
  let ENSRegistry
  let ENSRegistry2
  let ENSRegistryH
  let BaseRegistrar
  let BaseRegistrar2
  let BaseRegistrarH
  let NameWrapper
  let NameWrapper2
  let NameWrapperH
  let NameWrapperUpgraded
  let MetaDataservice
  let signers
  let accounts
  let account
  let account2
  let hacker
  let result
  let MAX_EXPIRY = 2n ** 64n - 1n

  /* Utility funcs */

  async function registerSetupAndWrapName(label, account, fuses) {
    const tokenId = labelhash(label)

    await BaseRegistrar.register(tokenId, account, 1 * DAY)

    await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)

    await NameWrapper.wrapETH2LD(label, account, fuses, EMPTY_ADDRESS)
  }

  before(async () => {
    signers = await ethers.getSigners()
    account = await signers[0].getAddress()
    account2 = await signers[1].getAddress()
    hacker = await signers[2].getAddress()

    EnsRegistry = await deploy('ENSRegistry')
    EnsRegistry2 = EnsRegistry.connect(signers[1])
    EnsRegistryH = EnsRegistry.connect(signers[2])

    BaseRegistrar = await deploy(
      'BaseRegistrarImplementation',
      EnsRegistry.address,
      namehash('arb'),
    )

    BaseRegistrar2 = BaseRegistrar.connect(signers[1])
    BaseRegistrarH = BaseRegistrar.connect(signers[2])

    await BaseRegistrar.addController(account)
    await BaseRegistrar.addController(account2)

    MetaDataservice = await deploy(
      'StaticMetadataService',
      'https://ens.domains',
    )

    NameWrapper = await deploy(
      'NameWrapper',
      EnsRegistry.address,
      BaseRegistrar.address,
      MetaDataservice.address,
    )
    NameWrapper2 = NameWrapper.connect(signers[1])
    NameWrapperH = NameWrapper.connect(signers[2])

    NameWrapperUpgraded = await deploy(
      'UpgradedNameWrapperMock',
      NameWrapper.address,
      EnsRegistry.address,
      BaseRegistrar.address,
    )

    // setup .arb
    await EnsRegistry.setSubnodeOwner(
      ROOT_NODE,
      labelhash('arb'),
      BaseRegistrar.address,
    )

    // setup .xyz
    await EnsRegistry.setSubnodeOwner(ROOT_NODE, labelhash('xyz'), account)

    //make sure base registrar is owner of arb TLD
    expect(await EnsRegistry.owner(namehash('arb'))).to.equal(
      BaseRegistrar.address,
    )
  })

  beforeEach(async () => {
    result = await ethers.provider.send('evm_snapshot')
  })
  afterEach(async () => {
    await ethers.provider.send('evm_revert', [result])
  })

  shouldBehaveLikeERC1155(
    () => [NameWrapper, signers],
    [
      namehash('test1.arb'),
      namehash('test2.arb'),
      namehash('doesnotexist.arb'),
    ],
    async (firstAddress, secondAddress) => {
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)

      await BaseRegistrar.register(labelhash('test1'), account, 1 * DAY)
      await NameWrapper.wrapETH2LD(
        'test1',
        firstAddress,
        CAN_DO_EVERYTHING,
        EMPTY_ADDRESS,
      )

      await BaseRegistrar.register(labelhash('test2'), account, 86400)
      await NameWrapper.wrapETH2LD(
        'test2',
        secondAddress,
        CAN_DO_EVERYTHING,
        EMPTY_ADDRESS,
      )
    },
  )

  shouldSupportInterfaces(
    () => NameWrapper,
    ['INameWrapper', 'IERC721Receiver'],
  )

  shouldRespectConstraints(
    () => ({
      BaseRegistrar,
      EnsRegistry,
      EnsRegistry2,
      NameWrapper,
      NameWrapper2,
    }),
    () => signers,
  )

  describe('wrap()', () => {
    it('Wraps a name if you are the owner', async () => {
      expect(await NameWrapper.ownerOf(namehash('xyz'))).to.equal(EMPTY_ADDRESS)

      await EnsRegistry.setApprovalForAll(NameWrapper.address, true)
      await NameWrapper.wrap(encodeName('xyz'), account, EMPTY_ADDRESS)
      expect(await NameWrapper.ownerOf(namehash('xyz'))).to.equal(account)
    })

    it('Allows specifying resolver', async () => {
      await EnsRegistry.setApprovalForAll(NameWrapper.address, true)
      await NameWrapper.wrap(encodeName('xyz'), account, account2)
      expect(await EnsRegistry.resolver(namehash('xyz'))).to.equal(account2)
    })

    it('emits event for Wrap', async () => {
      await EnsRegistry.setApprovalForAll(NameWrapper.address, true)

      const tx = NameWrapper.wrap(encodeName('xyz'), account, EMPTY_ADDRESS)
      await expect(tx)
        .to.emit(NameWrapper, 'NameWrapped')
        .withArgs(namehash('xyz'), encodeName('xyz'), account, 0, 0)
    })

    it('emits event for TransferSingle', async () => {
      await EnsRegistry.setApprovalForAll(NameWrapper.address, true)

      const tx = NameWrapper.wrap(encodeName('xyz'), account, EMPTY_ADDRESS)
      await expect(tx)
        .to.emit(NameWrapper, 'TransferSingle')
        .withArgs(account, EMPTY_ADDRESS, account, namehash('xyz'), 1)
    })

    it('Cannot wrap a name if the owner has not authorised the wrapper with the ENS registry.', async () => {
      await expect(NameWrapper.wrap(encodeName('xyz'), account, EMPTY_ADDRESS))
        .to.be.reverted
    })

    it('Will not allow wrapping with a target address of 0x0 or the wrapper contract address.', async () => {
      await EnsRegistry.setApprovalForAll(NameWrapper.address, true)
      await expect(
        NameWrapper.wrap(encodeName('xyz'), EMPTY_ADDRESS, EMPTY_ADDRESS),
      ).to.be.revertedWith('ERC1155: mint to the zero address')
    })

    it('Will not allow wrapping with a target address of the wrapper contract address.', async () => {
      await EnsRegistry.setApprovalForAll(NameWrapper.address, true)
      await expect(
        NameWrapper.wrap(encodeName('xyz'), NameWrapper.address, EMPTY_ADDRESS),
      ).to.be.revertedWith(
        'ERC1155: newOwner cannot be the NameWrapper contract',
      )
    })

    it('Allows an account approved by the owner on the ENS registry to wrap a name.', async () => {
      const labelHash = labelhash('abc')

      // setup .abc with account2 as owner
      await EnsRegistry.setSubnodeOwner(ROOT_NODE, labelHash, account2)
      // allow account to deal with all account2's names
      await EnsRegistry2.setApprovalForAll(account, true)
      await EnsRegistry2.setApprovalForAll(NameWrapper.address, true)

      //confirm abc is owner by account2 not account 1
      expect(await EnsRegistry.owner(namehash('abc'))).to.equal(account2)
      // wrap using account
      await NameWrapper.wrap(encodeName('abc'), account2, EMPTY_ADDRESS)
      const ownerOfWrappedXYZ = await NameWrapper.ownerOf(namehash('abc'))
      expect(ownerOfWrappedXYZ).to.equal(account2)
    })

    it('Does not allow anyone else to wrap a name even if the owner has authorised the wrapper with the ENS registry.', async () => {
      const labelHash = labelhash('abc')

      // setup .abc with account2 as owner
      await EnsRegistry.setSubnodeOwner(ROOT_NODE, labelHash, account2)
      await EnsRegistry2.setApprovalForAll(NameWrapper.address, true)

      //confirm abc is owner by account2 not account 1
      expect(await EnsRegistry.owner(namehash('abc'))).to.equal(account2)
      // wrap using account
      await expect(
        NameWrapper.wrap(encodeName('abc'), account2, EMPTY_ADDRESS),
      ).to.be.revertedWith(`Unauthorised("${namehash('abc')}", "${account}")`)
    })

    it('Does not allow wrapping .arb 2LDs.', async () => {
      const label = 'wrapped'
      const labelHash = labelhash(label)
      await BaseRegistrar.register(labelHash, account, 1 * DAY)
      await EnsRegistry.setApprovalForAll(NameWrapper.address, true)
      await expect(
        NameWrapper.wrap(encodeName('wrapped.arb'), account2, EMPTY_ADDRESS),
      ).to.be.revertedWith('IncompatibleParent()')
    })

    it('Can re-wrap a name that was reassigned by an unwrapped parent', async () => {
      expect(await NameWrapper.ownerOf(namehash('xyz'))).to.equal(EMPTY_ADDRESS)

      await EnsRegistry.setApprovalForAll(NameWrapper.address, true)
      await EnsRegistry.setSubnodeOwner(
        namehash('xyz'),
        labelhash('sub'),
        account,
      )
      await NameWrapper.wrap(encodeName('sub.xyz'), account, EMPTY_ADDRESS)

      await EnsRegistry.setSubnodeOwner(
        namehash('xyz'),
        labelhash('sub'),
        account2,
      )

      expect(await EnsRegistry.owner(namehash('sub.xyz'))).to.equal(account2)
      expect(await NameWrapper.ownerOf(namehash('sub.xyz'))).to.equal(account)

      await EnsRegistry2.setApprovalForAll(NameWrapper.address, true)
      const tx = await NameWrapper2.wrap(
        encodeName('sub.xyz'),
        account2,
        EMPTY_ADDRESS,
      )

      const nameHash = namehash('sub.xyz')

      await expect(tx)
        .to.emit(NameWrapper, 'NameUnwrapped')
        .withArgs(nameHash, EMPTY_ADDRESS)
      await expect(tx)
        .to.emit(NameWrapper, 'TransferSingle')
        .withArgs(account2, account, EMPTY_ADDRESS, nameHash, 1)
      await expect(tx)
        .to.emit(NameWrapper, 'NameWrapped')
        .withArgs(
          nameHash,
          encodeName('sub.xyz'),
          account2,
          CAN_DO_EVERYTHING,
          0,
        )
      await expect(tx)
        .to.emit(NameWrapper, 'TransferSingle')
        .withArgs(account2, EMPTY_ADDRESS, account2, nameHash, 1)

      expect(await NameWrapper2.ownerOf(nameHash)).to.equal(account2)
      expect(await EnsRegistry.owner(nameHash)).to.equal(NameWrapper.address)
    })

    it('Will not wrap a name with junk at the end', async () => {
      await EnsRegistry.setApprovalForAll(NameWrapper.address, true)
      await expect(
        NameWrapper.wrap(encodeName('xyz') + '123456', account, ZERO_ADDRESS),
      ).to.be.revertedWith('namehash: Junk at end of name')
    })

    it('Does not allow wrapping a name you do not own', async () => {
      // Register the name to account1
      await EnsRegistry.setApprovalForAll(NameWrapper.address, true)
      await NameWrapper.wrap(encodeName('xyz'), account, EMPTY_ADDRESS)

      // Deploy the destroy-your-name contract
      const NameGriefer = await deploy('NameGriefer', NameWrapper.address)

      // Try and burn the name
      await expect(NameGriefer.destroy(encodeName('xyz'))).to.be.reverted

      // Make sure it didn't succeed
      expect(await NameWrapper.ownerOf(namehash('xyz'))).to.equal(account)
    })

    it('Rewrapping a previously wrapped unexpired name retains PCC', async () => {
      const label = 'test'
      const labelHash = labelhash(label)
      const wrappedTokenId = namehash(label + '.arb')
      const subLabel = 'sub'
      const subLabelHash = labelhash(subLabel)
      const subWrappedTokenId = namehash(`${subLabel}.${label}.arb`)
      await registerSetupAndWrapName(label, account, CANNOT_UNWRAP)
      // Confirm that the name is wrapped
      const parentExpiry = await BaseRegistrar.nameExpires(labelHash)
      expect(await NameWrapper.ownerOf(wrappedTokenId)).to.equal(account)
      // NameWrapper.setSubnodeOwner to account2
      await NameWrapper.setSubnodeOwner(
        wrappedTokenId,
        subLabel,
        account2,
        PARENT_CANNOT_CONTROL,
        MAX_EXPIRY,
      )
      // COnfirm fuses are set
      const [, fusesBefore] = await NameWrapper.getData(subWrappedTokenId)
      expect(fusesBefore).to.equal(PARENT_CANNOT_CONTROL)
      await NameWrapper2.unwrap(wrappedTokenId, subLabelHash, account2)
      await EnsRegistry2.setApprovalForAll(NameWrapper.address, true)
      await NameWrapper2.wrap(
        encodeName(`${subLabel}.${label}.arb`),
        account2,
        EMPTY_ADDRESS,
      )
      const [, fuses, expiry] = await NameWrapper.getData(subWrappedTokenId)
      expect(fuses).to.equal(PARENT_CANNOT_CONTROL)
      expect(expiry).to.equal(parentExpiry.add(GRACE_PERIOD))
    })
  })

  describe('unwrap()', () => {
    it('Allows owner to unwrap name', async () => {
      await EnsRegistry.setApprovalForAll(NameWrapper.address, true)
      await NameWrapper.wrap(encodeName('xyz'), account, EMPTY_ADDRESS)
      await NameWrapper.setSubnodeOwner(
        namehash('xyz'),
        'unwrapped',
        account,
        0,
        0,
      )

      const ownerOfWrappedXYZ = await NameWrapper.ownerOf(
        namehash('unwrapped.xyz'),
      )
      expect(ownerOfWrappedXYZ).to.equal(account)
      await NameWrapper.unwrap(namehash('xyz'), labelhash('unwrapped'), account)

      //Transfers ownership in the ENS registry to the target address.
      expect(await EnsRegistry.owner(namehash('unwrapped.xyz'))).to.equal(
        account,
      )
    })

    it('Will not allow previous owner to unwrap name when name expires', async () => {
      await BaseRegistrar.register(labelhash('unwrapped'), account, 1 * DAY)
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)
      await NameWrapper.wrapETH2LD(
        'unwrapped',
        account,
        CANNOT_UNWRAP,
        EMPTY_ADDRESS,
      )
      await NameWrapper.setSubnodeOwner(
        namehash('unwrapped.arb'),
        'sub',
        account,
        PARENT_CANNOT_CONTROL,
        MAX_EXPIRY,
      )

      await evm.advanceTime(GRACE_PERIOD + 1 * DAY + 1)
      await evm.mine()

      await expect(
        NameWrapper.unwrap(
          namehash('unwrapped.arb'),
          labelhash('sub'),
          account,
        ),
      ).to.be.revertedWith(
        `Unauthorised("${namehash('sub.unwrapped.arb')}", "${account}")`,
      )
    })

    it('emits Unwrap event', async () => {
      await EnsRegistry.setApprovalForAll(NameWrapper.address, true)
      await NameWrapper.wrap(encodeName('xyz'), account, EMPTY_ADDRESS)
      const tx = await NameWrapper.unwrap(ROOT_NODE, labelhash('xyz'), account)

      await expect(tx)
        .to.emit(NameWrapper, 'NameUnwrapped')
        .withArgs(namehash('xyz'), account)
    })

    it('emits TransferSingle event', async () => {
      await EnsRegistry.setApprovalForAll(NameWrapper.address, true)
      await NameWrapper.wrap(encodeName('xyz'), account, EMPTY_ADDRESS)
      const tx = await NameWrapper.unwrap(ROOT_NODE, labelhash('xyz'), account)

      await expect(tx)
        .to.emit(NameWrapper, 'TransferSingle')
        .withArgs(account, account, EMPTY_ADDRESS, namehash('xyz'), 1)
    })

    it('Allows an account authorised by the owner on the NFT Wrapper to unwrap a name', async () => {
      const labelHash = labelhash('abc')

      // setup .abc with account2 as owner
      await EnsRegistry.setSubnodeOwner(ROOT_NODE, labelHash, account)

      await EnsRegistry.setApprovalForAll(NameWrapper.address, true)

      // wrap using account
      await NameWrapper.wrap(encodeName('abc'), account, EMPTY_ADDRESS)
      await NameWrapper.setApprovalForAll(account2, true)
      const ownerOfWrapperAbc = await NameWrapper.ownerOf(namehash('abc'))
      expect(ownerOfWrapperAbc).to.equal(account)

      //unwrap using account
      await NameWrapper2.unwrap(ROOT_NODE, labelhash('abc'), account2)
      expect(await EnsRegistry.owner(namehash('abc'))).to.equal(account2)
      expect(await NameWrapper.ownerOf(namehash('abc'))).to.equal(EMPTY_ADDRESS)
    })

    it('Does not allow an account authorised by the owner on the ENS registry to unwrap a name', async () => {
      const labelHash = labelhash('abc')

      // setup .abc with account2 as owner
      await EnsRegistry.setSubnodeOwner(ROOT_NODE, labelHash, account2)
      // allow account to deal with all account2's names
      await EnsRegistry2.setApprovalForAll(account, true)
      await EnsRegistry2.setApprovalForAll(NameWrapper.address, true)

      //confirm abc is owner by account2 not account 1
      expect(await EnsRegistry.owner(namehash('abc'))).to.equal(account2)
      // wrap using account
      await NameWrapper.wrap(encodeName('abc'), account2, EMPTY_ADDRESS)
      const ownerOfWrapperAbc = await NameWrapper.ownerOf(namehash('abc'))
      expect(ownerOfWrapperAbc).to.equal(account2)

      //unwrap using account
      await expect(NameWrapper.unwrap(ROOT_NODE, labelHash, account2)).to.be
        .reverted
    })

    it('Does not allow anyone else to unwrap a name', async () => {
      const labelHash = labelhash('abc')

      await EnsRegistry.setSubnodeOwner(ROOT_NODE, labelHash, account)
      await EnsRegistry.setApprovalForAll(NameWrapper.address, true)
      await NameWrapper.wrap(encodeName('abc'), account, EMPTY_ADDRESS)
      const ownerOfWrapperAbc = await NameWrapper.ownerOf(namehash('abc'))
      expect(ownerOfWrapperAbc).to.equal(account)
      //unwrap using account
      await expect(NameWrapper2.unwrap(ROOT_NODE, labelHash, account2)).to.be
        .reverted
    })

    it('Will not unwrap .arb 2LDs.', async () => {
      const label = 'unwrapped'
      const labelHash = labelhash(label)

      await BaseRegistrar.register(labelHash, account, 1 * DAY)

      //allow the restricted name wrappper to transfer the name to itself and reclaim it
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)

      await NameWrapper.wrapETH2LD(label, account, 0, EMPTY_ADDRESS)
      const ownerOfWrappedETH = await NameWrapper.ownerOf(
        namehash('unwrapped.arb'),
      )
      expect(ownerOfWrappedETH).to.equal(account)
      await expect(
        NameWrapper.unwrap(namehash('arb'), labelhash('unwrapped'), account),
      ).to.be.revertedWith('IncompatibleParent()')
    })

    it('Will not allow a target address of 0x0 or the wrapper contract address.', async () => {
      const labelHash = labelhash('abc')

      await EnsRegistry.setSubnodeOwner(ROOT_NODE, labelHash, account)
      await EnsRegistry.setApprovalForAll(NameWrapper.address, true)
      await NameWrapper.wrap(encodeName('abc'), account, EMPTY_ADDRESS)
      await expect(
        NameWrapper.unwrap(ROOT_NODE, labelHash, EMPTY_ADDRESS),
      ).to.be.revertedWith(`IncorrectTargetOwner("${EMPTY_ADDRESS}")`)

      await expect(
        NameWrapper.unwrap(ROOT_NODE, labelHash, NameWrapper.address),
      ).to.be.revertedWith(`IncorrectTargetOwner("${NameWrapper.address}")`)
    })

    it('Will not allow to unwrap with PCC/CU burned if expired', async () => {
      const label = 'awesome'
      const labelHash = labelhash(label)
      await BaseRegistrar.register(labelHash, account, 1 * DAY)
      await EnsRegistry.setSubnodeOwner(
        namehash('awesome.arb'),
        labelhash('sub'),
        account,
      )
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)

      await NameWrapper.wrapETH2LD(
        'awesome',
        account,
        CANNOT_UNWRAP,
        EMPTY_ADDRESS,
      )

      await EnsRegistry.setApprovalForAll(NameWrapper.address, true)

      await NameWrapper.setSubnodeOwner(
        namehash('awesome.arb'),
        'sub',
        account,
        PARENT_CANNOT_CONTROL | CANNOT_UNWRAP,
        0,
      )

      expect(await EnsRegistry.owner(namehash('sub.awesome.arb'))).to.equal(
        NameWrapper.address,
      )

      await expect(
        NameWrapper.unwrap(namehash('awesome.arb'), labelhash('sub'), account),
      ).to.be.revertedWith(
        `Unauthorised("${namehash('sub.awesome.arb')}", "${account}")`,
      )
    })

    it('Will allow to unwrap with PCC/CU burned if expired and then extended without PCC/CU', async () => {
      const label = 'awesome'
      const labelHash = labelhash(label)
      await BaseRegistrar.register(labelHash, account, 1 * DAY * 7)
      await EnsRegistry.setSubnodeOwner(
        namehash('awesome.arb'),
        labelhash('sub'),
        account,
      )

      const expiry = await BaseRegistrar.nameExpires(labelHash)

      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)

      await NameWrapper.wrapETH2LD(
        'awesome',
        account,
        CANNOT_UNWRAP,
        EMPTY_ADDRESS,
      )

      await EnsRegistry.setApprovalForAll(NameWrapper.address, true)

      const block = await ethers.provider.getBlock('latest')

      await NameWrapper.setSubnodeOwner(
        namehash('awesome.arb'),
        'sub',
        account,
        PARENT_CANNOT_CONTROL | CANNOT_UNWRAP,
        block.timestamp + DAY,
      )

      expect(await EnsRegistry.owner(namehash('sub.awesome.arb'))).to.equal(
        NameWrapper.address,
      )

      await evm.advanceTime(2 * DAY)
      await evm.mine()

      await expect(
        NameWrapper.unwrap(namehash('awesome.arb'), labelhash('sub'), account),
      ).to.be.revertedWith(
        `Unauthorised("${namehash('sub.awesome.arb')}", "${account}")`,
      )

      await NameWrapper.setSubnodeOwner(
        namehash('awesome.arb'),
        'sub',
        account,
        0,
        MAX_EXPIRY,
      )

      await NameWrapper.unwrap(
        namehash('awesome.arb'),
        labelhash('sub'),
        account,
      )

      expect(await EnsRegistry.owner(namehash('sub.awesome.arb'))).to.equal(
        account,
      )
    })

    it('Will not allow to unwrap a name with the CANNOT_UNWRAP fuse burned if not expired', async () => {
      const labelHash = labelhash('abc')

      await EnsRegistry.setSubnodeOwner(ROOT_NODE, labelHash, account)
      await EnsRegistry.setApprovalForAll(NameWrapper.address, true)

      await BaseRegistrar.register(labelHash, account, 1 * DAY)
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)
      await NameWrapper.wrapETH2LD('abc', account, CANNOT_UNWRAP, EMPTY_ADDRESS)
      await NameWrapper.setSubnodeOwner(
        namehash('abc.arb'),
        'sub',
        account,
        PARENT_CANNOT_CONTROL | CANNOT_UNWRAP,
        MAX_EXPIRY,
      )
      await expect(
        NameWrapper.unwrap(namehash('abc.arb'), labelhash('sub'), account),
      ).to.be.revertedWith(`OperationProhibited("${namehash('sub.abc.arb')}")`)
    })

    it('Unwrapping a previously wrapped unexpired name retains PCC and expiry', async () => {
      const label = 'test'
      const labelHash = labelhash(label)
      const wrappedTokenId = namehash(label + '.arb')
      const subLabel = 'sub'
      const subLabelHash = labelhash(subLabel)
      const subWrappedTokenId = namehash(`${subLabel}.${label}.arb`)
      await registerSetupAndWrapName(label, account, CANNOT_UNWRAP)
      // Confirm that the name is wrapped
      const parentExpiry = await BaseRegistrar.nameExpires(labelHash)
      expect(await NameWrapper.ownerOf(wrappedTokenId)).to.equal(account)
      // NameWrapper.setSubnodeOwner to account2
      await NameWrapper.setSubnodeOwner(
        wrappedTokenId,
        'sub',
        account2,
        PARENT_CANNOT_CONTROL,
        MAX_EXPIRY,
      )
      // Confirm fuses are set
      const [, fusesBefore] = await NameWrapper.getData(subWrappedTokenId)
      expect(fusesBefore).to.equal(PARENT_CANNOT_CONTROL)
      await NameWrapper2.unwrap(wrappedTokenId, subLabelHash, account2)
      const [, fuses, expiry] = await NameWrapper.getData(subWrappedTokenId)
      expect(fuses).to.equal(PARENT_CANNOT_CONTROL)
      expect(expiry).to.equal(parentExpiry.add(GRACE_PERIOD))
    })
  })

  describe('wrapETH2LD()', () => {
    const label = 'wrapped2'
    const labelHash = labelhash(label)
    const nameHash = namehash(label + '.arb')
    it('wraps a name if sender is owner', async () => {
      await BaseRegistrar.register(labelHash, account, 1 * DAY)

      //allow the restricted name wrappper to transfer the name to itself and reclaim it
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)

      expect(await NameWrapper.ownerOf(nameHash)).to.equal(EMPTY_ADDRESS)

      await NameWrapper.wrapETH2LD(
        label,
        account,
        CAN_DO_EVERYTHING,
        EMPTY_ADDRESS,
      )

      //make sure reclaim claimed ownership for the wrapper in registry

      expect(await EnsRegistry.owner(nameHash)).to.equal(NameWrapper.address)

      //make sure owner in the wrapper is the user

      expect(await NameWrapper.ownerOf(nameHash)).to.equal(account)

      // make sure registrar ERC721 is owned by Wrapper

      expect(await BaseRegistrar.ownerOf(labelHash)).to.equal(
        NameWrapper.address,
      )
    })

    it('Cannot wrap a name if the owner has not authorised the wrapper with the .arb registrar.', async () => {
      await BaseRegistrar.register(labelHash, account, 1 * DAY)
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, false)
      const approved = await BaseRegistrar.isApprovedForAll(
        account,
        NameWrapper.address,
      )
      expect(approved).to.equal(false)
      await expect(
        NameWrapper.wrapETH2LD(
          label,
          account,
          CAN_DO_EVERYTHING,
          EMPTY_ADDRESS,
        ),
      ).to.be.reverted
    })

    it('Allows specifying resolver', async () => {
      await BaseRegistrar.register(labelHash, account, 1 * DAY)
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)
      await NameWrapper.wrapETH2LD(label, account, CAN_DO_EVERYTHING, account2)
      expect(await EnsRegistry.resolver(nameHash)).to.equal(account2)
    })

    it('Can re-wrap a name that was wrapped has already expired on the .arb registrar', async () => {
      await BaseRegistrar.register(labelHash, account, 1 * DAY)
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)
      await NameWrapper.wrapETH2LD(
        label,
        account,
        CAN_DO_EVERYTHING,
        EMPTY_ADDRESS,
      )
      await increaseTime(DAY * GRACE_PERIOD + DAY + 1)
      await mine()

      expect(await BaseRegistrar.available(labelHash)).to.equal(true)

      await BaseRegistrar2.register(labelHash, account2, 1 * DAY)
      const expectedExpiry = await BaseRegistrar2.nameExpires(labelHash)
      expect(await BaseRegistrar.ownerOf(labelHash)).to.equal(account2)
      await BaseRegistrar2.setApprovalForAll(NameWrapper.address, true)
      const tx = await NameWrapper2.wrapETH2LD(
        label,
        account2,
        CAN_DO_EVERYTHING,
        EMPTY_ADDRESS,
      )

      // Check the 4 events
      // UnwrapETH2LD of the original owner
      // TransferSingle burn of the original token
      // WrapETH2LD to the new owner with fuses
      // TransferSingle to mint the new token

      await expect(tx)
        .to.emit(NameWrapper, 'NameUnwrapped')
        .withArgs(namehash('wrapped2.arb'), EMPTY_ADDRESS)
      await expect(tx)
        .to.emit(NameWrapper, 'TransferSingle')
        .withArgs(account2, account, EMPTY_ADDRESS, nameHash, 1)
      await expect(tx)
        .to.emit(NameWrapper, 'NameWrapped')
        .withArgs(
          namehash('wrapped2.arb'),
          encodeName('wrapped2.arb'),
          account2,
          PARENT_CANNOT_CONTROL | IS_DOT_ETH,
          expectedExpiry.add(GRACE_PERIOD),
        )
      await expect(tx)
        .to.emit(NameWrapper, 'TransferSingle')
        .withArgs(account2, EMPTY_ADDRESS, account2, nameHash, 1)

      expect(await NameWrapper2.ownerOf(nameHash)).to.equal(account2)
      expect(await BaseRegistrar.ownerOf(labelHash)).to.equal(
        NameWrapper.address,
      )
    })

    it('Can re-wrap a name that was wrapped has already expired even if CANNOT_TRANSFER was burned', async () => {
      await BaseRegistrar.register(labelHash, account, 1 * DAY)
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)
      await NameWrapper.wrapETH2LD(
        label,
        account,
        CANNOT_UNWRAP | CANNOT_TRANSFER,
        EMPTY_ADDRESS,
      )
      await increaseTime(DAY * GRACE_PERIOD + DAY + 1)
      await mine()

      expect(await BaseRegistrar.available(labelHash)).to.equal(true)

      await BaseRegistrar2.register(labelHash, account2, 1 * DAY)
      const expectedExpiry = await BaseRegistrar.nameExpires(labelHash)
      expect(await BaseRegistrar.ownerOf(labelHash)).to.equal(account2)
      await BaseRegistrar2.setApprovalForAll(NameWrapper.address, true)
      const tx = await NameWrapper2.wrapETH2LD(
        label,
        account2,
        CAN_DO_EVERYTHING,
        EMPTY_ADDRESS,
      )

      await expect(tx)
        .to.emit(NameWrapper, 'NameUnwrapped')
        .withArgs(namehash('wrapped2.arb'), EMPTY_ADDRESS)
      await expect(tx)
        .to.emit(NameWrapper, 'TransferSingle')
        .withArgs(account2, account, EMPTY_ADDRESS, nameHash, 1)
      await expect(tx)
        .to.emit(NameWrapper, 'NameWrapped')
        .withArgs(
          namehash('wrapped2.arb'),
          encodeName('wrapped2.arb'),
          account2,
          PARENT_CANNOT_CONTROL | IS_DOT_ETH,
          expectedExpiry.add(GRACE_PERIOD),
        )
      await expect(tx)
        .to.emit(NameWrapper, 'TransferSingle')
        .withArgs(account2, EMPTY_ADDRESS, account2, nameHash, 1)

      expect(await NameWrapper2.ownerOf(nameHash)).to.equal(account2)
      expect(await BaseRegistrar.ownerOf(labelHash)).to.equal(
        NameWrapper.address,
      )
    })

    it('correctly reports fuses for a name that has expired and been rewrapped more permissively', async () => {
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)

      // Register the name
      await BaseRegistrar.register(labelHash, account, 1 * DAY)

      // Wrap it
      await NameWrapper.wrapETH2LD(label, account, CANNOT_UNWRAP, EMPTY_ADDRESS)
      let [, fuses, expiry] = await NameWrapper.getData(
        namehash('wrapped2.arb'),
      )
      expect(fuses).to.equal(CANNOT_UNWRAP | PARENT_CANNOT_CONTROL | IS_DOT_ETH)

      // Create a subdomain that can't be unwrapped
      await NameWrapper.setSubnodeOwner(
        namehash('wrapped2.arb'),
        'sub',
        account,
        PARENT_CANNOT_CONTROL | CANNOT_UNWRAP,
        MAX_EXPIRY,
      )
      ;[, fuses] = await NameWrapper.getData(namehash('sub.wrapped2.arb'))
      expect(fuses).to.equal(PARENT_CANNOT_CONTROL | CANNOT_UNWRAP)

      // Fast forward until the 2LD expires
      await increaseTime(DAY * GRACE_PERIOD + DAY + 1)
      await mine()

      // Register from another address
      await BaseRegistrar2.register(labelHash, account2, 1 * DAY)
      const expectedExpiry =
        (await BaseRegistrar.nameExpires(labelHash)).toNumber() + GRACE_PERIOD
      await BaseRegistrar2.setApprovalForAll(NameWrapper.address, true)
      await NameWrapper2.wrapETH2LD(
        label,
        account2,
        CAN_DO_EVERYTHING,
        EMPTY_ADDRESS,
      )
      ;[, fuses, expiry] = await NameWrapper.getData(namehash('wrapped2.arb'))
      expect(fuses).to.equal(PARENT_CANNOT_CONTROL | IS_DOT_ETH)
      expect(expiry).to.equal(expectedExpiry)

      //sub domain fuses get reset
      ;[, fuses] = await NameWrapper.getData(namehash('sub.wrapped2.arb'))
      expect(fuses).to.equal(0)
    })

    it('correctly reports fuses for a name that has expired and been rewrapped more permissively with registerAndWrap()', async () => {
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)

      // Register the name
      await BaseRegistrar.register(labelHash, account, 1 * DAY)

      // Wrap it
      await NameWrapper.wrapETH2LD(label, account, CANNOT_UNWRAP, EMPTY_ADDRESS)
      let [, fuses, expiry] = await NameWrapper.getData(
        namehash('wrapped2.arb'),
      )
      expect(fuses).to.equal(CANNOT_UNWRAP | PARENT_CANNOT_CONTROL | IS_DOT_ETH)

      // Create a subdomain that can't be unwrapped
      await NameWrapper.setSubnodeOwner(
        namehash('wrapped2.arb'),
        'sub',
        account,
        PARENT_CANNOT_CONTROL | CANNOT_UNWRAP,
        MAX_EXPIRY,
      )
      ;[, fuses] = await NameWrapper.getData(namehash('sub.wrapped2.arb'))
      expect(fuses).to.equal(PARENT_CANNOT_CONTROL | CANNOT_UNWRAP)

      // Fast forward until the 2LD expires
      await increaseTime(DAY * GRACE_PERIOD + DAY + 1)
      await mine()

      // Register from another address with registerAndWrap()
      await BaseRegistrar.addController(NameWrapper.address)
      await NameWrapper.setController(account, account)
      await NameWrapper.registerAndWrapETH2LD(
        label,
        account2,
        DAY,
        EMPTY_ADDRESS,
        0,
      )
      const expectedExpiry =
        (await BaseRegistrar.nameExpires(labelHash)).toNumber() + GRACE_PERIOD
      ;[, fuses, expiry] = await NameWrapper.getData(namehash('wrapped2.arb'))
      expect(fuses).to.equal(PARENT_CANNOT_CONTROL | IS_DOT_ETH)
      expect(expiry).to.equal(expectedExpiry)

      //sub domain fuses get reset
      ;[, fuses] = await NameWrapper.getData(namehash('sub.wrapped2.arb'))
      expect(fuses).to.equal(0)
    })

    it('emits Wrap event', async () => {
      await BaseRegistrar.register(labelHash, account, 1 * DAY)
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)
      const tx = await NameWrapper.wrapETH2LD(
        label,
        account,
        CAN_DO_EVERYTHING,
        EMPTY_ADDRESS,
      )

      const expiry = await BaseRegistrar.nameExpires(labelHash)
      await expect(tx)
        .to.emit(NameWrapper, 'NameWrapped')
        .withArgs(
          namehash('wrapped2.arb'),
          encodeName('wrapped2.arb'),
          account,
          PARENT_CANNOT_CONTROL | IS_DOT_ETH,
          expiry.add(GRACE_PERIOD),
        )
    })

    it('emits TransferSingle event', async () => {
      await BaseRegistrar.register(labelHash, account, 1 * DAY)
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)
      const tx = await NameWrapper.wrapETH2LD(
        label,
        account,
        CAN_DO_EVERYTHING,
        EMPTY_ADDRESS,
      )
      await expect(tx)
        .to.emit(NameWrapper, 'TransferSingle')
        .withArgs(account, EMPTY_ADDRESS, account, nameHash, 1)
    })

    it('Transfers the wrapped token to the target address.', async () => {
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)
      await BaseRegistrar.register(labelHash, account, 1 * DAY)
      await NameWrapper.wrapETH2LD(
        label,
        account2,
        CAN_DO_EVERYTHING,
        EMPTY_ADDRESS,
      )
      expect(await NameWrapper.ownerOf(nameHash)).to.equal(account2)
    })

    it('Does not allow wrapping with a target address of 0x0', async () => {
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)
      await BaseRegistrar.register(labelHash, account, 1 * DAY)
      await expect(
        NameWrapper.wrapETH2LD(
          label,
          EMPTY_ADDRESS,
          CAN_DO_EVERYTHING,
          EMPTY_ADDRESS,
        ),
      ).to.be.revertedWith('ERC1155: mint to the zero address')
    })

    it('Does not allow wrapping with a target address of the wrapper contract address.', async () => {
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)
      await BaseRegistrar.register(labelHash, account, 1 * DAY)

      await expect(
        NameWrapper.wrapETH2LD(
          label,
          NameWrapper.address,
          CAN_DO_EVERYTHING,
          EMPTY_ADDRESS,
        ),
      ).to.be.revertedWith(
        'ERC1155: newOwner cannot be the NameWrapper contract',
      )
    })

    it('Allows an account approved by the owner on the .arb registrar to wrap a name.', async () => {
      await BaseRegistrar.register(labelHash, account, 1 * DAY)
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)
      await BaseRegistrar.setApprovalForAll(account2, true)

      await NameWrapper2.wrapETH2LD(label, account, 0, EMPTY_ADDRESS)

      expect(await NameWrapper.ownerOf(nameHash)).to.equal(account)
    })

    it('Does not allow anyone else to wrap a name even if the owner has authorised the wrapper with the ENS registry.', async () => {
      await BaseRegistrar.register(labelHash, account, 1 * DAY)

      await EnsRegistry.setApprovalForAll(NameWrapper.address, true)
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)

      await expect(
        NameWrapper2.wrapETH2LD(label, account, 0, EMPTY_ADDRESS),
      ).to.be.revertedWith(`Unauthorised("${nameHash}", "${account2}")`)
    })

    it('Can wrap a name even if the controller address is different to the registrant address.', async () => {
      await BaseRegistrar.register(labelHash, account, 1 * DAY)
      await EnsRegistry.setOwner(nameHash, account2)
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)

      await NameWrapper.wrapETH2LD(label, account, 0, EMPTY_ADDRESS)

      expect(await NameWrapper.ownerOf(nameHash)).to.equal(account)
    })

    it('Does not allow the controller of a name to wrap it if they are not also the registrant.', async () => {
      await BaseRegistrar.register(labelHash, account, 1 * DAY)
      await EnsRegistry.setOwner(nameHash, account2)
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)

      await expect(NameWrapper2.wrapETH2LD(label, account2, 0, EMPTY_ADDRESS))
        .to.be.reverted
    })

    it('Does not allows fuse to be burned if CANNOT_UNWRAP has not been burned.', async () => {
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)
      await BaseRegistrar.register(labelHash, account, 1 * DAY)
      await expect(
        NameWrapper.wrapETH2LD(
          label,
          account,
          CANNOT_SET_RESOLVER,
          EMPTY_ADDRESS,
        ),
      ).to.be.revertedWith(`OperationProhibited("${nameHash}")`)
    })

    it('cannot burn any parent controlled fuse', async () => {
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)
      await BaseRegistrar.register(labelHash, account, 1 * DAY)

      for (let i = 0; i < 7; i++) {
        try {
          await NameWrapper.wrapETH2LD(
            label,
            account,
            IS_DOT_ETH * 2 ** i, // next undefined fuse
            EMPTY_ADDRESS,
          )
        } catch (e) {
          expect(e.reason).to.contain('value out-of-bounds')
        }
      }
    })

    it('Allows fuse to be burned if CANNOT_UNWRAP has been burned', async () => {
      const initialFuses = CANNOT_UNWRAP | CANNOT_SET_RESOLVER
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)
      await BaseRegistrar.register(labelHash, account, 1 * DAY)
      await NameWrapper.wrapETH2LD(label, account, initialFuses, EMPTY_ADDRESS)
      const [, fuses] = await NameWrapper.getData(nameHash)
      expect(fuses).to.equal(initialFuses | PARENT_CANNOT_CONTROL | IS_DOT_ETH)
    })

    it('Allows fuse to be burned if CANNOT_UNWRAP has been burned, but resets to 0 if expired', async () => {
      const initialFuses = CANNOT_UNWRAP | CANNOT_SET_RESOLVER
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)
      await BaseRegistrar.register(labelHash, account, 1 * DAY)
      await NameWrapper.wrapETH2LD(label, account, initialFuses, EMPTY_ADDRESS)

      await increaseTime(DAY + 1 + GRACE_PERIOD)
      await mine()
      const [, fuses] = await NameWrapper.getData(nameHash)
      expect(fuses).to.equal(0)
    })

    it('Will not wrap an empty name', async () => {
      await BaseRegistrar.register(labelhash(''), account, 1 * DAY)
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)
      await expect(
        NameWrapper.wrapETH2LD('', account, CAN_DO_EVERYTHING, ZERO_ADDRESS),
      ).to.be.revertedWith(`LabelTooShort()`)
    })

    it('Will not wrap a label greater than 255 characters', async () => {
      const longString =
        'yutaioxtcsbzrqhdjmltsdfkgomogohhcchjoslfhqgkuhduhxqsldnurwrrtoicvthwxytonpcidtnkbrhccaozdtoznedgkfkifsvjukxxpkcmgcjprankyzerzqpnuteuegtfhqgzcxqwttyfewbazhyilqhyffufxrookxrnjkmjniqpmntcbrowglgdpkslzechimsaonlcvjkhhvdvkvvuztihobmivifuqtvtwinljslusvhhbwhuhzty'
      expect(longString.length).to.equal(256)
      await BaseRegistrar.register(labelhash(longString), account, 1 * DAY)
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)
      await expect(
        NameWrapper.wrapETH2LD(
          longString,
          account,
          CAN_DO_EVERYTHING,
          ZERO_ADDRESS,
        ),
      ).to.be.revertedWith(`LabelTooLong("${longString}")`)
    })

    it('Rewrapping a previously wrapped unexpired name retains PCC and expiry', async () => {
      // register and wrap a name with PCC
      await BaseRegistrar.register(labelHash, account, 1 * DAY)
      const parentExpiry = await BaseRegistrar.nameExpires(labelHash)
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)
      await NameWrapper.wrapETH2LD(
        label,
        account,
        CAN_DO_EVERYTHING,
        ZERO_ADDRESS,
      )
      // unwrap it
      await NameWrapper.unwrapETH2LD(labelHash, account, account)
      // rewrap it without PCC being burned
      await NameWrapper.wrapETH2LD(
        label,
        account,
        CAN_DO_EVERYTHING,
        ZERO_ADDRESS,
      )
      // check that the PCC is still there
      const [, fuses, expiry] = await NameWrapper.getData(nameHash)
      expect(fuses).to.equal(PARENT_CANNOT_CONTROL | IS_DOT_ETH)
      expect(expiry).to.equal(parentExpiry.add(GRACE_PERIOD))
    })
  })

  describe('unwrapETH2LD()', () => {
    const label = 'unwrapped'
    const labelHash = labelhash(label)
    const nameHash = namehash(label + '.arb')
    it('Allows the owner to unwrap a name.', async () => {
      await BaseRegistrar.register(labelHash, account, 1 * DAY)

      //allow the restricted name wrappper to transfer the name to itself and reclaim it
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)

      await NameWrapper.wrapETH2LD(
        label,
        account,
        CAN_DO_EVERYTHING,
        EMPTY_ADDRESS,
      )
      expect(await NameWrapper.ownerOf(namehash('unwrapped.arb'))).to.equal(
        account,
      )
      await NameWrapper.unwrapETH2LD(labelHash, account, account)
      // transfers the controller on the .arb registrar to the target address.
      expect(await EnsRegistry.owner(namehash('unwrapped.arb'))).to.equal(
        account,
      )
      //Transfers the registrant on the .arb registrar to the target address
      expect(await BaseRegistrar.ownerOf(labelHash)).to.equal(account)
    })

    it('Does not allows the previous owner to unwrap when the name has expired.', async () => {
      await BaseRegistrar.register(labelHash, account, 1 * DAY)

      //allow the restricted name wrappper to transfer the name to itself and reclaim it
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)

      await NameWrapper.wrapETH2LD(
        label,
        account,
        CAN_DO_EVERYTHING,
        EMPTY_ADDRESS,
      )
      expect(await NameWrapper.ownerOf(namehash('unwrapped.arb'))).to.equal(
        account,
      )

      await increaseTime(DAY + 1)
      await mine()
      await expect(
        NameWrapper.unwrapETH2LD(labelHash, account, account),
      ).to.be.revertedWith(`Unauthorised("${nameHash}", "${account}")`)
    })

    it('emits Unwrap event', async () => {
      await BaseRegistrar.register(labelHash, account, 1 * DAY)
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)
      await NameWrapper.wrapETH2LD(
        label,
        account,
        CAN_DO_EVERYTHING,
        EMPTY_ADDRESS,
      )
      const tx = await NameWrapper.unwrapETH2LD(labelHash, account, account)
      await expect(tx)
        .to.emit(NameWrapper, 'NameUnwrapped')
        .withArgs(namehash('unwrapped.arb'), account)
    })

    it('Emits TransferSingle event', async () => {
      await BaseRegistrar.register(labelHash, account, 1 * DAY)
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)
      await NameWrapper.wrapETH2LD(
        label,
        account,
        CAN_DO_EVERYTHING,
        EMPTY_ADDRESS,
      )
      const tx = await NameWrapper.unwrapETH2LD(labelHash, account, account)
      await expect(tx)
        .to.emit(NameWrapper, 'TransferSingle')
        .withArgs(account, account, EMPTY_ADDRESS, nameHash, 1)
    })
    it('Does not allows an account authorised by the owner on the ENS registrar to unwrap a name', async () => {
      await BaseRegistrar.register(labelHash, account, 1 * DAY)
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)
      await BaseRegistrar.setApprovalForAll(account2, true)
      await NameWrapper.wrapETH2LD(
        label,
        account,
        CAN_DO_EVERYTHING,
        EMPTY_ADDRESS,
      )
      await expect(
        NameWrapper2.unwrapETH2LD(labelHash, account2, account2),
      ).to.be.revertedWith(`Unauthorised("${nameHash}", "${account2}")`)
    })

    it('Does not allow anyone else to unwrap a name even if the owner has authorised the wrapper with the ENS registry.', async () => {
      await BaseRegistrar.register(labelHash, account, 1 * DAY)
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)
      await EnsRegistry.setApprovalForAll(account2, true)
      await NameWrapper.wrapETH2LD(
        label,
        account,
        CAN_DO_EVERYTHING,
        EMPTY_ADDRESS,
      )
      await expect(
        NameWrapper2.unwrapETH2LD(labelHash, account2, account2),
      ).to.be.revertedWith(`Unauthorised("${nameHash}", "${account2}")`)
    })

    it('Does not allow a name to be unwrapped if CANNOT_UNWRAP fuse has been burned', async () => {
      await BaseRegistrar.register(labelHash, account, 1 * DAY)
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)
      await NameWrapper.wrapETH2LD(label, account, CANNOT_UNWRAP, EMPTY_ADDRESS)
      await expect(
        NameWrapper.unwrapETH2LD(labelHash, account, account),
      ).to.be.revertedWith(
        'OperationProhibited("0xbb7d787fe3173f5ee43d9616afca7cbd40c9824f2be1d61def0bbbad110261f7")',
      )
    })
    it('Unwrapping a previously wrapped unexpired name retains PCC and expiry', async () => {
      // register and wrap a name with PCC
      await BaseRegistrar.register(labelHash, account, 1 * DAY)
      const parentExpiry = await BaseRegistrar.nameExpires(labelHash)
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)
      await NameWrapper.wrapETH2LD(
        label,
        account,
        CAN_DO_EVERYTHING,
        ZERO_ADDRESS,
      )
      // unwrap it
      await NameWrapper.unwrapETH2LD(labelHash, account, account)
      // check that the Parent controlled fuses are still there
      const [, fuses, expiry] = await NameWrapper.getData(nameHash)
      expect(fuses).to.equal(PARENT_CANNOT_CONTROL | IS_DOT_ETH)
      expect(expiry).to.equal(parentExpiry.add(GRACE_PERIOD))
    })
  })

  describe('ownerOf()', () => {
    it('Returns the owner', async () => {
      const label = 'subdomain'
      const tokenId = labelhash(label)
      const wrappedTokenId = namehash(label + '.arb')
      const CAN_DO_EVERYTHING = 0

      await BaseRegistrar.register(tokenId, account, 1 * DAY)

      const ownerInBaseRegistrar = await BaseRegistrar.ownerOf(tokenId)

      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)
      await NameWrapper.wrapETH2LD(
        label,
        account,
        CAN_DO_EVERYTHING,
        EMPTY_ADDRESS,
      )

      const owner = await NameWrapper.ownerOf(wrappedTokenId)

      expect(owner).to.equal(account)
    })
  })
  describe('setUpgradeContract()', () => {
    it('Reverts if called by someone that is not the owner', async () => {
      // Attempt to attack the contract by setting the upgrade contract to themselves
      await expect(
        NameWrapper2.setUpgradeContract(account2),
      ).to.be.revertedWith('Ownable: caller is not the owner')
    })
    it('Will setApprovalForAll for the upgradeContract addresses in the registrar and registry to true', async () => {
      expect(
        await BaseRegistrar.isApprovedForAll(
          NameWrapper.address,
          NameWrapperUpgraded.address,
        ),
      ).to.equal(false)
      expect(
        await EnsRegistry.isApprovedForAll(
          NameWrapper.address,
          NameWrapperUpgraded.address,
        ),
      ).to.equal(false)

      //set the upgradeContract of the NameWrapper contract
      await NameWrapper.setUpgradeContract(NameWrapperUpgraded.address)

      expect(
        await BaseRegistrar.isApprovedForAll(
          NameWrapper.address,
          NameWrapperUpgraded.address,
        ),
      ).to.equal(true)
      expect(
        await EnsRegistry.isApprovedForAll(
          NameWrapper.address,
          NameWrapperUpgraded.address,
        ),
      ).to.equal(true)
    })
    it('Will setApprovalForAll for the old upgradeContract addresses in the registrar and registry to false', async () => {
      //set the upgradeContract of the NameWrapper contract
      await NameWrapper.setUpgradeContract(DUMMY_ADDRESS)

      expect(
        await BaseRegistrar.isApprovedForAll(
          NameWrapper.address,
          DUMMY_ADDRESS,
        ),
      ).to.equal(true)
      expect(
        await EnsRegistry.isApprovedForAll(NameWrapper.address, DUMMY_ADDRESS),
      ).to.equal(true)

      //set the upgradeContract of the NameWrapper contract
      await NameWrapper.setUpgradeContract(NameWrapperUpgraded.address)

      expect(
        await BaseRegistrar.isApprovedForAll(
          NameWrapper.address,
          NameWrapperUpgraded.address,
        ),
      ).to.equal(true)
      expect(
        await EnsRegistry.isApprovedForAll(
          NameWrapper.address,
          NameWrapperUpgraded.address,
        ),
      ).to.equal(true)

      expect(
        await BaseRegistrar.isApprovedForAll(
          NameWrapper.address,
          DUMMY_ADDRESS,
        ),
      ).to.equal(false)
      expect(
        await EnsRegistry.isApprovedForAll(NameWrapper.address, DUMMY_ADDRESS),
      ).to.equal(false)
    })
    it('Will not setApprovalForAll for the new upgrade address if it is the address(0)', async () => {
      //set the upgradeContract of the NameWrapper contract
      await NameWrapper.setUpgradeContract(NameWrapperUpgraded.address)

      expect(
        await BaseRegistrar.isApprovedForAll(
          NameWrapper.address,
          NameWrapperUpgraded.address,
        ),
      ).to.equal(true)
      expect(
        await EnsRegistry.isApprovedForAll(
          NameWrapper.address,
          NameWrapperUpgraded.address,
        ),
      ).to.equal(true)

      //set the upgradeContract of the NameWrapper contract
      await NameWrapper.setUpgradeContract(ZERO_ADDRESS)

      expect(
        await BaseRegistrar.isApprovedForAll(NameWrapper.address, ZERO_ADDRESS),
      ).to.equal(false)
      expect(
        await EnsRegistry.isApprovedForAll(NameWrapper.address, ZERO_ADDRESS),
      ).to.equal(false)
    })
  })

  describe('upgradeETH2LD()', () => {
    const label = 'wrapped2'
    const labelHash = labelhash(label)
    const nameHash = namehash(label + '.arb')

    it('Upgrades a .arb name if sender is owner', async () => {
      await BaseRegistrar.register(labelHash, account, 1 * DAY)
      const expectedExpiry = await BaseRegistrar.nameExpires(labelHash)
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)

      expect(await NameWrapper.ownerOf(nameHash)).to.equal(EMPTY_ADDRESS)

      await NameWrapper.wrapETH2LD(
        label,
        account,
        CAN_DO_EVERYTHING,
        EMPTY_ADDRESS,
      )

      //make sure reclaim claimed ownership for the wrapper in registry

      expect(await EnsRegistry.owner(nameHash)).to.equal(NameWrapper.address)
      expect(await NameWrapper.ownerOf(nameHash)).to.equal(account)
      expect(await BaseRegistrar.ownerOf(labelHash)).to.equal(
        NameWrapper.address,
      )

      //set the upgradeContract of the NameWrapper contract
      await NameWrapper.setUpgradeContract(NameWrapperUpgraded.address)
      const tx = await NameWrapper.upgradeETH2LD(label, account, account2)

      //make sure owner of the registry is updated to the new upgraded contract

      expect(await EnsRegistry.owner(nameHash)).to.equal(
        NameWrapperUpgraded.address,
      )

      expect(await BaseRegistrar.ownerOf(labelHash)).to.equal(
        NameWrapperUpgraded.address,
      )

      // check the upgraded namewrapper is called with all parameters required

      await expect(tx)
        .to.emit(NameWrapperUpgraded, 'WrapETH2LD')
        .withArgs(
          label,
          account,
          PARENT_CANNOT_CONTROL | IS_DOT_ETH,
          expectedExpiry.add(GRACE_PERIOD),
          account2,
        )
    })

    it('Upgrades a .arb name if sender is authorised by the owner', async () => {
      await BaseRegistrar.register(labelHash, account, 1 * DAY)
      const expectedExpiry = await BaseRegistrar.nameExpires(labelHash)
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)
      await NameWrapper.setApprovalForAll(account2, true)
      await NameWrapper.wrapETH2LD(
        label,
        account,
        CAN_DO_EVERYTHING,
        EMPTY_ADDRESS,
      )

      expect(await EnsRegistry.owner(nameHash)).to.equal(NameWrapper.address)
      expect(await NameWrapper.ownerOf(nameHash)).to.equal(account)
      expect(await BaseRegistrar.ownerOf(labelHash)).to.equal(
        NameWrapper.address,
      )

      await NameWrapper.setUpgradeContract(NameWrapperUpgraded.address)

      const tx = await NameWrapper2.upgradeETH2LD(label, account2, account)

      expect(await BaseRegistrar.ownerOf(labelHash)).to.equal(
        NameWrapperUpgraded.address,
      )
      expect(await EnsRegistry.owner(nameHash)).to.equal(
        NameWrapperUpgraded.address,
      )
      await expect(tx)
        .to.emit(NameWrapperUpgraded, 'WrapETH2LD')
        .withArgs(
          label,
          account2,
          PARENT_CANNOT_CONTROL | IS_DOT_ETH,
          expectedExpiry.add(GRACE_PERIOD),
          account,
        )
    })

    it('Cannot upgrade a name if the upgradeContract has not been set.', async () => {
      await BaseRegistrar.register(labelHash, account, 1 * DAY)

      //allow the restricted name wrappper to transfer the name to itself and reclaim it
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)

      await NameWrapper.wrapETH2LD(
        label,
        account,
        CAN_DO_EVERYTHING,
        EMPTY_ADDRESS,
      )

      await expect(
        NameWrapper.upgradeETH2LD(label, account, EMPTY_ADDRESS),
      ).to.be.revertedWith(`CannotUpgrade()`)
    })

    it('Cannot upgrade a name if the upgradeContract has been set and then set back to the 0 address.', async () => {
      await BaseRegistrar.register(labelHash, account, 1 * DAY)
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)
      await NameWrapper.wrapETH2LD(
        label,
        account,
        CAN_DO_EVERYTHING,
        EMPTY_ADDRESS,
      )
      await NameWrapper.setUpgradeContract(NameWrapperUpgraded.address)

      expect(await NameWrapper.upgradeContract()).to.equal(
        NameWrapperUpgraded.address,
      )

      await NameWrapper.setUpgradeContract(EMPTY_ADDRESS)
      await expect(
        NameWrapper.upgradeETH2LD(label, account, EMPTY_ADDRESS),
      ).to.be.revertedWith(`CannotUpgrade()`)
    })

    it('Will pass fuses and expiry to the upgradedContract without any changes.', async () => {
      await BaseRegistrar.register(labelHash, account, 1 * DAY)

      //allow the restricted name wrappper to transfer the name to itself and reclaim it
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)

      await NameWrapper.wrapETH2LD(
        label,
        account,
        CANNOT_UNWRAP | CANNOT_SET_RESOLVER,
        EMPTY_ADDRESS,
      )

      //set the upgradeContract of the NameWrapper contract
      await NameWrapper.setUpgradeContract(NameWrapperUpgraded.address)

      const expectedExpiry = (await BaseRegistrar.nameExpires(labelHash)).add(
        GRACE_PERIOD,
      )

      const tx = await NameWrapper.upgradeETH2LD(label, account, EMPTY_ADDRESS)

      // assert the fuses and expiry have been passed through to the new NameWrapper
      await expect(tx)
        .to.emit(NameWrapperUpgraded, 'WrapETH2LD')
        .withArgs(
          label,
          account,
          PARENT_CANNOT_CONTROL |
            CANNOT_UNWRAP |
            CANNOT_SET_RESOLVER |
            IS_DOT_ETH,
          expectedExpiry,
          EMPTY_ADDRESS,
        )
    })

    it('Will burn the token, fuses and expiry of the name in the NameWrapper contract when upgraded.', async () => {
      await BaseRegistrar.register(labelHash, account, 1 * DAY)
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)
      const parentExpiry = await BaseRegistrar.nameExpires(labelHash)
      await NameWrapper.wrapETH2LD(label, account, CANNOT_UNWRAP, EMPTY_ADDRESS)

      await NameWrapper.setUpgradeContract(NameWrapperUpgraded.address)

      await NameWrapper.upgradeETH2LD(label, account, EMPTY_ADDRESS)

      expect(await NameWrapper.ownerOf(nameHash)).to.equal(EMPTY_ADDRESS)

      const [, fuses, expiry] = await NameWrapper.getData(nameHash)

      expect(fuses).to.equal(CANNOT_UNWRAP | PARENT_CANNOT_CONTROL | IS_DOT_ETH)
      expect(expiry).to.equal(parentExpiry.add(GRACE_PERIOD))
    })

    it('will revert if called twice by the original owner', async () => {
      await BaseRegistrar.register(labelHash, account, 1 * DAY)
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)

      await NameWrapper.wrapETH2LD(label, account, CANNOT_UNWRAP, EMPTY_ADDRESS)

      await NameWrapper.setUpgradeContract(NameWrapperUpgraded.address)

      await NameWrapper.upgradeETH2LD(label, account, EMPTY_ADDRESS)

      expect(await NameWrapper.ownerOf(nameHash)).to.equal(EMPTY_ADDRESS)

      await expect(
        NameWrapper.upgradeETH2LD(label, account, EMPTY_ADDRESS),
      ).to.be.revertedWith(`Unauthorised("${nameHash}", "${account}")`)
    })

    it('Will allow you to set the resolver on upgrade.', async () => {
      await BaseRegistrar.register(labelHash, account, 1 * DAY)
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)

      await NameWrapper.wrapETH2LD(label, account, 0, DUMMY_ADDRESS)

      await NameWrapper.setUpgradeContract(NameWrapperUpgraded.address)

      await NameWrapper.upgradeETH2LD(label, account, DUMMY_ADDRESS)

      const resolver = await EnsRegistry.resolver(nameHash)

      expect(resolver).to.equal(DUMMY_ADDRESS)
    })
    it('Does not allow anyone else to upgrade a name even if the owner has authorised the wrapper with the ENS registry.', async () => {
      await BaseRegistrar.register(labelHash, account, 1 * DAY)
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)
      await EnsRegistry.setApprovalForAll(NameWrapper.address, true)

      await NameWrapper.wrapETH2LD(
        label,
        account,
        CAN_DO_EVERYTHING,
        EMPTY_ADDRESS,
      )

      //set the upgradeContract of the NameWrapper contract
      await NameWrapper.setUpgradeContract(NameWrapperUpgraded.address)

      await expect(
        NameWrapper2.upgradeETH2LD(label, EMPTY_ADDRESS, EMPTY_ADDRESS),
      ).to.be.revertedWith(`Unauthorised("${nameHash}", "${account2}")`)
    })
  })

  describe('upgrade()', () => {
    const label = 'wrapped2'
    const labelHash = labelhash(label)
    const nameHash = namehash(label + '.arb')

    it('Allows owner to upgrade name', async () => {
      await EnsRegistry.setApprovalForAll(NameWrapper.address, true)
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)
      await BaseRegistrar.register(labelHash, account, 1 * DAY)
      await NameWrapper.wrapETH2LD(label, account, CANNOT_UNWRAP, EMPTY_ADDRESS)
      await NameWrapper.setSubnodeOwner(nameHash, 'to-upgrade', account, 0, 0)
      const ownerOfWrapped = await NameWrapper.ownerOf(
        namehash('to-upgrade.wrapped2.arb'),
      )
      expect(ownerOfWrapped).to.equal(account)

      //set the upgradeContract of the NameWrapper contract
      await NameWrapper.setUpgradeContract(NameWrapperUpgraded.address)

      expect(
        await EnsRegistry.isApprovedForAll(
          NameWrapper.address,
          NameWrapperUpgraded.address,
        ),
      ).to.equal(true)

      const tx = await NameWrapper.upgrade(
        namehash('wrapped2.arb'),
        'to-upgrade',
        account,
        EMPTY_ADDRESS,
      )

      //make sure owner of the registry is updated to the new upgraded contract

      expect(
        await EnsRegistry.owner(namehash('to-upgrade.wrapped2.arb')),
      ).to.equal(NameWrapperUpgraded.address)

      //make sure owner in the upgraded NameWrapper contract is the user

      await expect(tx)
        .to.emit(NameWrapperUpgraded, 'SetSubnodeRecord')
        .withArgs(
          namehash('wrapped2.arb'),
          'to-upgrade',
          account,
          EMPTY_ADDRESS,
          0,
          0,
          0,
        )
    })

    it('upgrades a name if sender is authroized by the owner', async () => {
      await EnsRegistry.setApprovalForAll(NameWrapper.address, true)
      await NameWrapper.setApprovalForAll(account2, true)

      await NameWrapper.wrap(encodeName('xyz'), account, EMPTY_ADDRESS)
      await NameWrapper.setSubnodeOwner(
        namehash('xyz'),
        'to-upgrade',
        account,
        0,
        0,
      )
      const ownerOfWrappedXYZ = await NameWrapper.ownerOf(
        namehash('to-upgrade.xyz'),
      )
      expect(ownerOfWrappedXYZ).to.equal(account)

      //set the upgradeContract of the NameWrapper contract
      await NameWrapper.setUpgradeContract(NameWrapperUpgraded.address)

      expect(
        await EnsRegistry.isApprovedForAll(
          NameWrapper.address,
          NameWrapperUpgraded.address,
        ),
      ).to.equal(true)

      const tx = await NameWrapper2.upgrade(
        namehash('xyz'),
        'to-upgrade',
        account,
        EMPTY_ADDRESS,
      )

      expect(await EnsRegistry.owner(namehash('to-upgrade.xyz'))).to.equal(
        NameWrapperUpgraded.address,
      )

      await expect(tx)
        .to.emit(NameWrapperUpgraded, 'SetSubnodeRecord')
        .withArgs(
          namehash('xyz'),
          'to-upgrade',
          account,
          EMPTY_ADDRESS,
          0,
          0,
          0,
        )
    })

    it('Cannot upgrade a name if the upgradeContract has not been set.', async () => {
      await EnsRegistry.setApprovalForAll(NameWrapper.address, true)
      await NameWrapper.wrap(encodeName('xyz'), account, EMPTY_ADDRESS)
      await NameWrapper.setSubnodeOwner(
        namehash('xyz'),
        'to-upgrade',
        account,
        0,
        0,
      )
      const ownerOfWrappedXYZ = await NameWrapper.ownerOf(
        namehash('to-upgrade.xyz'),
      )
      expect(ownerOfWrappedXYZ).to.equal(account)

      await expect(
        NameWrapper.upgrade(
          namehash('xyz'),
          'to-upgrade',
          account,
          EMPTY_ADDRESS,
        ),
      ).to.be.revertedWith(`CannotUpgrade()`)
    })

    it('Will pass fuses and expiry to the upgradedContract without any changes.', async () => {
      const name = 'to-upgrade.wrapped2.arb'
      await EnsRegistry.setApprovalForAll(NameWrapper.address, true)
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)
      await BaseRegistrar.register(labelHash, account, 1 * DAY)
      await NameWrapper.wrapETH2LD(label, account, CANNOT_UNWRAP, EMPTY_ADDRESS)
      await NameWrapper.setSubnodeOwner(
        nameHash,
        'to-upgrade',
        account,
        PARENT_CANNOT_CONTROL | CANNOT_UNWRAP | CANNOT_TRANSFER,
        MAX_EXPIRY,
      )
      const ownerOfWrapped = await NameWrapper.ownerOf(namehash(name))
      expect(ownerOfWrapped).to.equal(account)

      //set the upgradeContract of the NameWrapper contract
      await NameWrapper.setUpgradeContract(NameWrapperUpgraded.address)

      expect(
        await EnsRegistry.isApprovedForAll(
          NameWrapper.address,
          NameWrapperUpgraded.address,
        ),
      ).to.equal(true)

      const tx = await NameWrapper.upgrade(
        namehash('wrapped2.arb'),
        'to-upgrade',
        account,
        EMPTY_ADDRESS,
      )

      expect(await EnsRegistry.owner(namehash(name))).to.equal(
        NameWrapperUpgraded.address,
      )

      const expectedExpiry = await BaseRegistrar.nameExpires(labelHash)
      const expectedFuses =
        PARENT_CANNOT_CONTROL | CANNOT_UNWRAP | CANNOT_TRANSFER

      await expect(tx)
        .to.emit(NameWrapperUpgraded, 'SetSubnodeRecord')
        .withArgs(
          namehash('wrapped2.arb'),
          'to-upgrade',
          account,
          EMPTY_ADDRESS,
          0,
          expectedFuses,
          expectedExpiry.add(GRACE_PERIOD),
        )
    })

    it('Will burn the token of the name in the NameWrapper contract when upgraded, but keep expiry and fuses', async () => {
      const name = 'to-upgrade.wrapped2.arb'
      const FUSES = PARENT_CANNOT_CONTROL | CANNOT_UNWRAP | CANNOT_TRANSFER
      await EnsRegistry.setApprovalForAll(NameWrapper.address, true)
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)
      await BaseRegistrar.register(labelHash, account, 1 * DAY)
      const parentExpiry = await BaseRegistrar.nameExpires(labelHash)
      await NameWrapper.wrapETH2LD(label, account, CANNOT_UNWRAP, EMPTY_ADDRESS)
      await NameWrapper.setSubnodeOwner(
        nameHash,
        'to-upgrade',
        account,
        FUSES,
        MAX_EXPIRY,
      )
      const ownerOfWrapped = await NameWrapper.ownerOf(namehash(name))
      expect(ownerOfWrapped).to.equal(account)

      //set the upgradeContract of the NameWrapper contract
      await NameWrapper.setUpgradeContract(NameWrapperUpgraded.address)

      expect(
        await EnsRegistry.isApprovedForAll(
          NameWrapper.address,
          NameWrapperUpgraded.address,
        ),
      ).to.equal(true)

      const tx = await NameWrapper.upgrade(
        namehash('wrapped2.arb'),
        'to-upgrade',
        account,
        EMPTY_ADDRESS,
      )

      expect(await EnsRegistry.owner(namehash(name))).to.equal(
        NameWrapperUpgraded.address,
      )

      expect(
        await NameWrapper.ownerOf(namehash('to-upgrade.wrapped2.arb')),
      ).to.equal(EMPTY_ADDRESS)

      const [, fuses, expiry] = await NameWrapper.getData(
        namehash('to-upgrade.wrapped2.arb'),
      )

      expect(fuses).to.equal(FUSES)
      expect(expiry).to.equal(parentExpiry.add(GRACE_PERIOD))
    })

    it('reverts if called twice by the original owner', async () => {
      const name = 'to-upgrade.wrapped2.arb'
      await EnsRegistry.setApprovalForAll(NameWrapper.address, true)
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)
      await BaseRegistrar.register(labelHash, account, 1 * DAY)
      await NameWrapper.wrapETH2LD(label, account, CANNOT_UNWRAP, EMPTY_ADDRESS)
      await NameWrapper.setSubnodeOwner(
        nameHash,
        'to-upgrade',
        account,
        PARENT_CANNOT_CONTROL | CANNOT_UNWRAP | CANNOT_TRANSFER,
        MAX_EXPIRY,
      )
      const ownerOfWrapped = await NameWrapper.ownerOf(namehash(name))
      expect(ownerOfWrapped).to.equal(account)

      //set the upgradeContract of the NameWrapper contract
      await NameWrapper.setUpgradeContract(NameWrapperUpgraded.address)

      expect(
        await EnsRegistry.isApprovedForAll(
          NameWrapper.address,
          NameWrapperUpgraded.address,
        ),
      ).to.equal(true)

      await NameWrapper.upgrade(
        namehash('wrapped2.arb'),
        'to-upgrade',
        account,
        EMPTY_ADDRESS,
      )

      expect(await EnsRegistry.owner(namehash(name))).to.equal(
        NameWrapperUpgraded.address,
      )

      await expect(
        NameWrapper.upgrade(
          namehash('wrapped2.arb'),
          'to-upgrade',
          account2,
          EMPTY_ADDRESS,
        ),
      ).to.be.revertedWith(
        `Unauthorised("${namehash('to-upgrade.wrapped2.arb')}", "${account}")`,
      )
    })

    it('Will pass resolver to the upgradedContract without any changes.', async () => {
      await EnsRegistry.setApprovalForAll(NameWrapper.address, true)

      await NameWrapper.wrap(encodeName('xyz'), account, EMPTY_ADDRESS)

      await NameWrapper.setSubnodeRecord(
        namehash('xyz'),
        'to-upgrade',
        account,
        account2,
        0,
        0,
        0,
      )
      const ownerOfWrappedXYZ = await NameWrapper.ownerOf(
        namehash('to-upgrade.xyz'),
      )
      expect(ownerOfWrappedXYZ).to.equal(account)

      //set the upgradeContract of the NameWrapper contract
      await NameWrapper.setUpgradeContract(NameWrapperUpgraded.address)

      expect(
        await EnsRegistry.isApprovedForAll(
          NameWrapper.address,
          NameWrapperUpgraded.address,
        ),
      ).to.equal(true)

      const tx = await NameWrapper.upgrade(
        namehash('xyz'),
        'to-upgrade',
        account,
        account2,
      )

      expect(await EnsRegistry.owner(namehash('to-upgrade.xyz'))).to.equal(
        NameWrapperUpgraded.address,
      )

      expect(tx)
        .to.emit(NameWrapperUpgraded, 'SetSubnodeRecord')
        .withArgs(namehash('xyz'), 'to-upgrade', account, account2, 0, 0, 0)
    })

    it('Does not allow anyone else to upgrade a name even if the owner has authorised the wrapper with the ENS registry.', async () => {
      await EnsRegistry.setApprovalForAll(NameWrapper.address, true)

      await NameWrapper.wrap(encodeName('xyz'), account, EMPTY_ADDRESS)

      await NameWrapper.setSubnodeOwner(
        namehash('xyz'),
        'to-upgrade',
        account,
        0,
        0,
      )

      const ownerOfWrappedXYZ = await NameWrapper.ownerOf(
        namehash('to-upgrade.xyz'),
      )
      expect(ownerOfWrappedXYZ).to.equal(account)

      //set the upgradeContract of the NameWrapper contract
      await NameWrapper.setUpgradeContract(NameWrapperUpgraded.address)

      await expect(
        NameWrapper2.upgrade(
          namehash('xyz'),
          'to-upgrade',
          account,
          EMPTY_ADDRESS,
        ),
      ).to.be.revertedWith(
        `Unauthorised("${namehash('to-upgrade.xyz')}", "${account2}")`,
      )
    })
  })

  describe('setFuses()', () => {
    const label = 'fuses'
    const tokenId = labelhash('fuses')
    const wrappedTokenId = namehash('fuses.arb')

    it('cannot burn PARENT_CANNOT_CONTROL', async () => {
      await BaseRegistrar.register(labelhash('abc'), account, 1 * DAY)
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)
      await NameWrapper.wrapETH2LD('abc', account, CANNOT_UNWRAP, EMPTY_ADDRESS)

      await NameWrapper.setSubnodeOwner(
        namehash('abc.arb'),
        'sub',
        account,
        CAN_DO_EVERYTHING,
        MAX_EXPIRY,
      )

      try {
        await NameWrapper.setFuses(
          namehash('sub.abc.arb'),
          PARENT_CANNOT_CONTROL,
        )
      } catch (e) {
        expect(e.reason).to.equal('value out-of-bounds')
      }
    })

    it('cannot burn any parent controlled fuse', async () => {
      await BaseRegistrar.register(labelhash('abc'), account, 1 * DAY)
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)
      await NameWrapper.wrapETH2LD('abc', account, CANNOT_UNWRAP, EMPTY_ADDRESS)

      await NameWrapper.setSubnodeOwner(
        namehash('abc.arb'),
        'sub',
        account,
        CANNOT_UNWRAP | PARENT_CANNOT_CONTROL,
        MAX_EXPIRY,
      )

      // check the 7 fuses above PCC
      for (let i = 0; i < 7; i++) {
        try {
          await NameWrapper.setFuses(
            namehash('sub.abc.arb'),
            IS_DOT_ETH * 2 ** i,
          )
        } catch (e) {
          expect(e.reason).to.contain('value out-of-bounds')
        }
      }
    })

    it('Errors when manually changing calldata to incorrect type', async () => {
      await BaseRegistrar.register(labelhash('abc'), account, 1 * DAY)
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)
      await NameWrapper.wrapETH2LD('abc', account, CANNOT_UNWRAP, EMPTY_ADDRESS)

      await NameWrapper.setSubnodeOwner(
        namehash('abc.arb'),
        'sub',
        account,
        CANNOT_UNWRAP | PARENT_CANNOT_CONTROL,
        MAX_EXPIRY,
      )

      const tx = await NameWrapper.populateTransaction.setFuses(
        namehash('sub.abc.arb'),
        4,
      )
      const rogueFuse = '40000' // 2 ** 18 in hex
      tx.data = tx.data.substring(0, tx.data.length - rogueFuse.length)
      tx.data += String(rogueFuse)
      try {
        await signers[0].sendTransaction(tx)
      } catch (e) {
        expect(e.message).to.equal(
          `Transaction reverted: function was called with incorrect parameters`,
        )
      }
    })

    it('cannot burn fuses as the previous owner of a .arb when the name has expired', async () => {
      await BaseRegistrar.register(labelhash('abc'), account, 1 * DAY)
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)
      await NameWrapper.wrapETH2LD('abc', account, CANNOT_UNWRAP, EMPTY_ADDRESS)

      await evm.advanceTime(GRACE_PERIOD + 1 * DAY + 1)
      await evm.mine()

      await expect(
        NameWrapper.setFuses(namehash('abc.arb'), CANNOT_UNWRAP),
      ).to.be.revertedWith(
        `Unauthorised("${namehash('abc.arb')}", "${account}")`,
      )
    })

    it('cannot burn fuses as a previous owner of a non .arb when the name has expired', async () => {
      await BaseRegistrar.register(labelhash('abc'), account, 1 * DAY)
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)
      await NameWrapper.wrapETH2LD('abc', account, CANNOT_UNWRAP, EMPTY_ADDRESS)

      await NameWrapper.setSubnodeOwner(
        namehash('abc.arb'),
        'sub',
        account,
        CANNOT_UNWRAP | PARENT_CANNOT_CONTROL,
        MAX_EXPIRY,
      )

      await evm.advanceTime(GRACE_PERIOD + 1 * DAY + 1)
      await evm.mine()

      await expect(
        NameWrapper.setFuses(namehash('sub.abc.arb'), CANNOT_UNWRAP),
      ).to.be.revertedWith(
        `Unauthorised("${namehash('sub.abc.arb')}", "${account}")`,
      )
    })

    it('Will not allow burning fuses if PARENT_CANNOT_CONTROL has not been burned', async () => {
      await BaseRegistrar.register(labelhash('abc'), account, 1 * DAY)
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)
      await NameWrapper.wrapETH2LD('abc', account, CANNOT_UNWRAP, EMPTY_ADDRESS)

      await NameWrapper.setSubnodeOwner(
        namehash('abc.arb'),
        'sub',
        account,
        CAN_DO_EVERYTHING,
        MAX_EXPIRY,
      )

      await expect(
        NameWrapper.setFuses(
          namehash('sub.abc.arb'),
          CANNOT_UNWRAP | CANNOT_TRANSFER,
        ),
      ).to.be.revertedWith(
        `OperationProhibited("0x5f1471f6276eafe687a7aceabaea0bce02fafaf1dfbeb787b3725234022ee294")`,
      )
    })

    it('Will not allow burning fuses of subdomains if CANNOT_UNWRAP has not been burned', async () => {
      await BaseRegistrar.register(labelhash('abc'), account, 1 * DAY)
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)
      await NameWrapper.wrapETH2LD('abc', account, CANNOT_UNWRAP, EMPTY_ADDRESS)

      await NameWrapper.setSubnodeOwner(
        namehash('abc.arb'),
        'sub',
        account,
        PARENT_CANNOT_CONTROL,
        MAX_EXPIRY,
      )

      await expect(
        NameWrapper.setFuses(namehash('sub.abc.arb'), CANNOT_TRANSFER),
      ).to.be.revertedWith(
        `OperationProhibited("0x5f1471f6276eafe687a7aceabaea0bce02fafaf1dfbeb787b3725234022ee294")`,
      )
    })

    it('Will not allow burning fuses of .arb names unless CANNOT_UNWRAP is also burned.', async () => {
      await BaseRegistrar.register(tokenId, account, 1 * DAY)

      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)

      await NameWrapper.wrapETH2LD(
        label,
        account,
        CAN_DO_EVERYTHING,
        EMPTY_ADDRESS,
      )

      await expect(
        NameWrapper.setFuses(wrappedTokenId, CANNOT_TRANSFER),
      ).to.be.revertedWith(`OperationProhibited("${wrappedTokenId}")`)
    })

    it('Can be called by the owner', async () => {
      await BaseRegistrar.register(tokenId, account, 1 * DAY)

      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)

      await NameWrapper.wrapETH2LD(label, account, CANNOT_UNWRAP, EMPTY_ADDRESS)

      let [, fuses] = await NameWrapper.getData(wrappedTokenId)
      expect(fuses).to.equal(CANNOT_UNWRAP | PARENT_CANNOT_CONTROL | IS_DOT_ETH)

      await NameWrapper.setFuses(wrappedTokenId, CANNOT_TRANSFER)
      ;[, fuses] = await NameWrapper.getData(wrappedTokenId)
      expect(fuses).to.equal(
        CANNOT_UNWRAP | CANNOT_TRANSFER | PARENT_CANNOT_CONTROL | IS_DOT_ETH,
      )
    })

    it('Emits BurnFusesEvent', async () => {
      await BaseRegistrar.register(tokenId, account, 1 * DAY)

      const expectedExpiry =
        (await BaseRegistrar.nameExpires(tokenId)).toNumber() + GRACE_PERIOD
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)

      await NameWrapper.wrapETH2LD(label, account, CANNOT_UNWRAP, EMPTY_ADDRESS)

      const tx = await NameWrapper.setFuses(wrappedTokenId, CANNOT_TRANSFER)

      await expect(tx)
        .to.emit(NameWrapper, 'FusesSet')
        .withArgs(
          wrappedTokenId,
          CANNOT_UNWRAP | CANNOT_TRANSFER | PARENT_CANNOT_CONTROL | IS_DOT_ETH,
          expectedExpiry,
        )

      const [, fuses, expiry] = await NameWrapper.getData(wrappedTokenId)
      expect(fuses).to.equal(
        CANNOT_UNWRAP | CANNOT_TRANSFER | PARENT_CANNOT_CONTROL | IS_DOT_ETH,
      )
      expect(expiry).to.equal(expectedExpiry)
    })

    it('Can be called by an account authorised by the owner', async () => {
      await BaseRegistrar.register(tokenId, account, 1 * DAY)

      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)

      await NameWrapper.wrapETH2LD(
        label,
        account,
        CAN_DO_EVERYTHING,
        EMPTY_ADDRESS,
      )

      await NameWrapper.setApprovalForAll(account2, true)

      await NameWrapper2.setFuses(wrappedTokenId, CANNOT_UNWRAP)

      const [, fuses] = await NameWrapper.getData(wrappedTokenId)
      expect(fuses).to.equal(CANNOT_UNWRAP | PARENT_CANNOT_CONTROL | IS_DOT_ETH)
    })
    it('Cannot be called by an unauthorised account', async () => {
      await BaseRegistrar.register(tokenId, account, 1 * DAY)

      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)

      await NameWrapper.wrapETH2LD(
        label,
        account,
        CAN_DO_EVERYTHING,
        EMPTY_ADDRESS,
      )

      await expect(
        NameWrapper2.setFuses(
          wrappedTokenId,
          CAN_DO_EVERYTHING | CANNOT_UNWRAP,
        ),
      ).to.be.revertedWith(`Unauthorised("${wrappedTokenId}", "${account2}")`)
    })

    it('Allows burning unknown fuses', async () => {
      await BaseRegistrar.register(tokenId, account, 1 * DAY)

      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)

      await NameWrapper.wrapETH2LD(label, account, CANNOT_UNWRAP, EMPTY_ADDRESS)

      // Each fuse is represented by the next bit, 64 is the next undefined fuse

      await NameWrapper.setFuses(wrappedTokenId, 64)

      const [, fuses] = await NameWrapper.getData(wrappedTokenId)
      expect(fuses).to.equal(
        CANNOT_UNWRAP | PARENT_CANNOT_CONTROL | IS_DOT_ETH | 64,
      )
    })

    it('Logically ORs passed in fuses with already-burned fuses.', async () => {
      await BaseRegistrar.register(tokenId, account, 1 * DAY)

      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)

      await NameWrapper.wrapETH2LD(
        label,
        account,
        CANNOT_UNWRAP | CANNOT_TRANSFER,
        EMPTY_ADDRESS,
      )

      await NameWrapper.setFuses(wrappedTokenId, 64 | CANNOT_TRANSFER)

      const [, fuses] = await NameWrapper.getData(wrappedTokenId)
      expect(fuses).to.equal(
        CANNOT_UNWRAP |
          PARENT_CANNOT_CONTROL |
          IS_DOT_ETH |
          64 |
          CANNOT_TRANSFER,
      )
    })

    it('can set fuses and then burn ability to burn fuses', async () => {
      const label = 'burnabilitytoburn'
      const tokenId = labelhash(label)
      const wrappedTokenId = namehash(label + '.arb')
      const CAN_DO_EVERYTHING = 0

      await BaseRegistrar.register(tokenId, account, 1 * DAY)

      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)

      await NameWrapper.wrapETH2LD(label, account, CANNOT_UNWRAP, EMPTY_ADDRESS)

      await NameWrapper.setFuses(wrappedTokenId, CANNOT_BURN_FUSES)

      const ownerInWrapper = await NameWrapper.ownerOf(wrappedTokenId)

      expect(ownerInWrapper).to.equal(account)

      // check flag in the wrapper

      expect(
        await NameWrapper.allFusesBurned(wrappedTokenId, CANNOT_BURN_FUSES),
      ).to.equal(true)

      //try to set the resolver and ttl
      await expect(
        NameWrapper.setFuses(wrappedTokenId, CANNOT_TRANSFER),
      ).to.be.revertedWith(`OperationProhibited("${wrappedTokenId}"`)
    })

    it('can set fuses and burn transfer', async () => {
      const [, signer2] = await ethers.getSigners()
      const account2 = await signer2.getAddress()
      const label = 'fuses3'
      const tokenId = labelhash('fuses3')
      const wrappedTokenId = namehash('fuses3.arb')

      await BaseRegistrar.register(tokenId, account, 1 * DAY)

      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)

      await NameWrapper.wrapETH2LD(label, account, CANNOT_UNWRAP, EMPTY_ADDRESS)

      await NameWrapper.setFuses(wrappedTokenId, CANNOT_TRANSFER)

      expect(await NameWrapper.ownerOf(wrappedTokenId)).to.equal(account)

      // check flag in the wrapper

      expect(
        await NameWrapper.allFusesBurned(wrappedTokenId, CANNOT_TRANSFER),
      ).to.equal(true)

      //Transfer should revert
      await expect(
        NameWrapper.safeTransferFrom(
          account,
          account2,
          wrappedTokenId,
          1,
          '0x',
        ),
      ).to.be.revertedWith(`OperationProhibited("${wrappedTokenId}")`)
    })

    it('can set fuses and burn canSetResolver and canSetTTL', async () => {
      const label = 'fuses1'
      const tokenId = labelhash(label)
      const wrappedTokenId = namehash(label + '.arb')
      const CAN_DO_EVERYTHING = 0

      await BaseRegistrar.register(tokenId, account, 1 * DAY)

      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)

      await NameWrapper.wrapETH2LD(label, account, CANNOT_UNWRAP, EMPTY_ADDRESS)

      await NameWrapper.setFuses(
        wrappedTokenId,
        CANNOT_SET_RESOLVER | CANNOT_SET_TTL,
      )

      expect(await NameWrapper.ownerOf(wrappedTokenId)).to.equal(account)

      // check flag in the wrapper
      expect(
        await NameWrapper.allFusesBurned(
          wrappedTokenId,
          CANNOT_SET_RESOLVER | CANNOT_SET_TTL,
        ),
      ).to.equal(true)

      //try to set the resolver and ttl
      await expect(
        NameWrapper.setResolver(wrappedTokenId, account),
      ).to.be.revertedWith(`OperationProhibited("${wrappedTokenId}")`)

      await expect(NameWrapper.setTTL(wrappedTokenId, 1000)).to.be.revertedWith(
        `OperationProhibited("${wrappedTokenId}")`,
      )
    })

    it('can set fuses and burn canCreateSubdomains', async () => {
      const label = 'fuses2'
      const tokenId = labelhash(label)
      const wrappedTokenId = namehash(label + '.arb')

      await BaseRegistrar.register(tokenId, account, 1 * DAY)

      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)

      await NameWrapper.wrapETH2LD(label, account, CANNOT_UNWRAP, EMPTY_ADDRESS)

      expect(
        await NameWrapper.allFusesBurned(
          wrappedTokenId,
          CANNOT_CREATE_SUBDOMAIN,
        ),
      ).to.equal(false)

      // can create before burn

      //revert not approved and isn't sender because subdomain isnt owned by contract?
      await NameWrapper.setSubnodeOwner(
        wrappedTokenId,
        'creatable',
        account,
        CAN_DO_EVERYTHING,
        0,
      )

      expect(
        await EnsRegistry.owner(namehash('creatable.fuses2.arb')),
      ).to.equal(NameWrapper.address)

      expect(
        await NameWrapper.ownerOf(namehash('creatable.fuses2.arb')),
      ).to.equal(account)

      await NameWrapper.setFuses(
        wrappedTokenId,
        CAN_DO_EVERYTHING | CANNOT_CREATE_SUBDOMAIN,
      )

      const ownerInWrapper = await NameWrapper.ownerOf(wrappedTokenId)

      expect(ownerInWrapper).to.equal(account)

      expect(
        await NameWrapper.allFusesBurned(
          wrappedTokenId,
          CANNOT_CREATE_SUBDOMAIN,
        ),
      ).to.equal(true)

      //try to create a subdomain

      await expect(
        NameWrapper.setSubnodeOwner(
          namehash('fuses2.arb'),
          'uncreatable',
          account,
          0,
          86400,
        ),
      ).to.be.revertedWith(
        `OperationProhibited("${namehash('uncreatable.fuses2.arb')}")`,
      )
    })
  })

  describe('setChildFuses()', () => {
    const label = 'fuses'
    const tokenId = labelhash(label)
    const wrappedTokenId = namehash(`${label}.arb`)
    const subWrappedTokenId = namehash(`sub.${label}.arb`)

    it('Allows parent owners to set fuses/expiry', async () => {
      await registerSetupAndWrapName('fuses', account, CANNOT_UNWRAP)
      await NameWrapper.setSubnodeOwner(wrappedTokenId, 'sub', account, 0, 0)

      let [, fuses, expiry] = await NameWrapper.getData(
        namehash('sub.fuses.arb'),
      )

      expect(fuses).to.equal(0)
      expect(expiry).to.equal(0)

      await NameWrapper.setChildFuses(
        wrappedTokenId,
        labelhash('sub'),
        CANNOT_UNWRAP | PARENT_CANNOT_CONTROL,
        MAX_EXPIRY,
      )

      const expectedExpiry = await BaseRegistrar.nameExpires(tokenId)
      ;[, fuses, expiry] = await NameWrapper.getData(namehash('sub.fuses.arb'))

      expect(fuses).to.equal(CANNOT_UNWRAP | PARENT_CANNOT_CONTROL)
      expect(expiry).to.equal(expectedExpiry.add(GRACE_PERIOD))
    })

    it('Allows special cased TLD owners to set fuses/expiry', async () => {
      await EnsRegistry.setSubnodeOwner(
        ROOT_NODE,
        labelhash('anothertld'),
        account,
      )

      await EnsRegistry.setApprovalForAll(NameWrapper.address, true)
      await NameWrapper.wrap(encodeName('anothertld'), account, ZERO_ADDRESS)

      let [, fuses, expiry] = await NameWrapper.getData(
        namehash('sub.fuses.arb'),
      )

      expect(fuses).to.equal(0)
      expect(expiry).to.equal(0)

      const block = await ethers.provider.getBlock(
        await ethers.provider.getBlockNumber(),
      )

      const expectedExpiry = block.timestamp + 1000

      await NameWrapper.setChildFuses(
        ROOT_NODE,
        labelhash('anothertld'),
        CANNOT_UNWRAP | PARENT_CANNOT_CONTROL,
        expectedExpiry,
      )
      ;[, fuses, expiry] = await NameWrapper.getData(namehash('anothertld'))

      expect(fuses).to.equal(CANNOT_UNWRAP | PARENT_CANNOT_CONTROL)
      expect(expiry).to.equal(expectedExpiry)
    })

    it('does not allow parent owners to burn IS_DOT_ETH fuse', async () => {
      await registerSetupAndWrapName('fuses', account, CANNOT_UNWRAP)
      await NameWrapper.setSubnodeOwner(wrappedTokenId, 'sub', account, 0, 0)

      let [, fuses, expiry] = await NameWrapper.getData(
        namehash('sub.fuses.arb'),
      )

      expect(fuses).to.equal(0)
      expect(expiry).to.equal(0)

      await expect(
        NameWrapper.setChildFuses(
          wrappedTokenId,
          labelhash('sub'),
          CANNOT_UNWRAP | PARENT_CANNOT_CONTROL | IS_DOT_ETH,
          MAX_EXPIRY,
        ),
      ).to.be.revertedWith(`OperationProhibited("${subWrappedTokenId}")`)
    })

    it('Allow parent owners to burn parent controlled fuses without burning PCC', async () => {
      await registerSetupAndWrapName('fuses', account, CANNOT_UNWRAP)
      await NameWrapper.setSubnodeOwner(wrappedTokenId, 'sub', account, 0, 0)

      let [, fuses, expiry] = await NameWrapper.getData(
        namehash('sub.fuses.arb'),
      )

      expect(fuses).to.equal(0)
      expect(expiry).to.equal(0)

      await NameWrapper.setChildFuses(
        wrappedTokenId,
        labelhash('sub'),
        IS_DOT_ETH * 2, //Next undefined parent controlled fuse
        MAX_EXPIRY,
      )

      const [, fusesAfter] = await NameWrapper.getData(
        namehash('sub.fuses.arb'),
      )

      expect(fusesAfter).to.equal(IS_DOT_ETH * 2)
    })

    it('Does not allow parent owners to burn parent controlled fuses after burning PCC', async () => {
      await registerSetupAndWrapName('fuses', account, CANNOT_UNWRAP)
      await NameWrapper.setSubnodeOwner(wrappedTokenId, 'sub', account, 0, 0)

      let [, fuses, expiry] = await NameWrapper.getData(
        namehash('sub.fuses.arb'),
      )

      expect(fuses).to.equal(0)
      expect(expiry).to.equal(0)

      await NameWrapper.setChildFuses(
        wrappedTokenId,
        labelhash('sub'),
        PARENT_CANNOT_CONTROL,
        MAX_EXPIRY,
      )
      await expect(
        NameWrapper.setChildFuses(
          wrappedTokenId,
          labelhash('sub'),
          IS_DOT_ETH * 2, //Next undefined parent controlled fuse
          MAX_EXPIRY,
        ),
      ).to.be.revertedWith(
        `OperationProhibited("${namehash('sub.fuses.arb')}")`,
      )
    })

    it('Allows accounts authorised by the parent node owner to set fuses/expiry', async () => {
      await registerSetupAndWrapName('fuses', account, CANNOT_UNWRAP)
      await NameWrapper.setSubnodeOwner(wrappedTokenId, 'sub', account, 0, 0)

      let [, fuses, expiry] = await NameWrapper.getData(
        namehash('sub.fuses.arb'),
      )

      expect(fuses).to.equal(0)
      expect(expiry).to.equal(0)

      // approve account2 for anything account owns
      await NameWrapper.setApprovalForAll(account2, true)

      await NameWrapper2.setChildFuses(
        wrappedTokenId,
        labelhash('sub'),
        CANNOT_UNWRAP | PARENT_CANNOT_CONTROL,
        MAX_EXPIRY,
      )

      const expectedExpiry = await BaseRegistrar.nameExpires(tokenId)
      ;[, fuses, expiry] = await NameWrapper.getData(namehash('sub.fuses.arb'))

      expect(fuses).to.equal(CANNOT_UNWRAP | PARENT_CANNOT_CONTROL)
      expect(expiry).to.equal(expectedExpiry.add(GRACE_PERIOD))
    })

    it('Does not allow non-parent owners to set child fuses', async () => {
      const subWrappedTokenId = namehash('sub.fuses.arb')
      await registerSetupAndWrapName('fuses', account, CANNOT_UNWRAP)
      await NameWrapper.setSubnodeOwner(wrappedTokenId, 'sub', account, 0, 0)

      let [, fuses, expiry] = await NameWrapper.getData(subWrappedTokenId)

      expect(fuses).to.equal(0)
      expect(expiry).to.equal(0)

      await expect(
        NameWrapper2.setChildFuses(
          wrappedTokenId,
          labelhash('sub'),
          CANNOT_UNWRAP | PARENT_CANNOT_CONTROL,
          MAX_EXPIRY,
        ),
      ).to.be.revertedWith(
        `Unauthorised("${subWrappedTokenId}", "${account2}")`,
      )
    })

    it('Normalises expiry to the parent expiry', async () => {
      await registerSetupAndWrapName('fuses', account, CANNOT_UNWRAP)

      await NameWrapper.setSubnodeOwner(wrappedTokenId, 'sub', account, 0, 0)

      let [, , expiry] = await NameWrapper.getData(subWrappedTokenId)

      expect(expiry).to.equal(0)

      await NameWrapper.setChildFuses(
        wrappedTokenId,
        labelhash('sub'),
        CANNOT_UNWRAP | PARENT_CANNOT_CONTROL,
        MAX_EXPIRY,
      )

      // expiry of parent
      const [, , expectedExpiry] = await NameWrapper.getData(wrappedTokenId)

      ;[, , expiry] = await NameWrapper.getData(subWrappedTokenId)

      expect(expiry).to.equal(expectedExpiry)
    })

    it('Normalises expiry to the old expiry', async () => {
      await registerSetupAndWrapName('fuses', account, CANNOT_UNWRAP)

      await NameWrapper.setSubnodeOwner(wrappedTokenId, 'sub', account, 0, 1000)

      let [, , expiry] = await NameWrapper.getData(subWrappedTokenId)

      expect(expiry).to.equal(1000)

      await NameWrapper.setChildFuses(
        wrappedTokenId,
        labelhash('sub'),
        CANNOT_UNWRAP | PARENT_CANNOT_CONTROL,
        500,
      )
      ;[, , expiry] = await NameWrapper.getData(subWrappedTokenId)

      // normalises to 1000 instead of using 500
      expect(expiry).to.equal(1000)
    })

    it('Does not allow burning fuses if PARENT_CANNOT_CONTROL is not burnt', async () => {
      await registerSetupAndWrapName('fuses', account, CANNOT_UNWRAP)

      await NameWrapper.setSubnodeOwner(wrappedTokenId, 'sub', account, 0, 0)

      await expect(
        NameWrapper.setChildFuses(
          wrappedTokenId,
          labelhash('sub'),
          CANNOT_UNWRAP,
          MAX_EXPIRY,
        ),
      ).to.be.revertedWith(`OperationProhibited("${subWrappedTokenId}")`)
    })

    it('should not allow .arb to call setChildFuses()', async () => {
      await registerSetupAndWrapName('fuses', account, 0)

      await expect(
        NameWrapper.setChildFuses(
          namehash('arb'),
          tokenId,
          CANNOT_SET_RESOLVER,
          0,
        ),
      ).to.be.revertedWith(`Unauthorised("${wrappedTokenId}", "${account}")`)
    })

    it('Does not allow burning fuses if CANNOT_UNWRAP is not burnt', async () => {
      await registerSetupAndWrapName('fuses', account, CANNOT_UNWRAP)

      // set up child's PCC
      await NameWrapper.setSubnodeOwner(
        wrappedTokenId,
        'sub',
        account,
        PARENT_CANNOT_CONTROL,
        1000,
      )

      // attempt to burn a fuse with CANNOT_UNWRAP
      await expect(
        NameWrapper.setChildFuses(
          wrappedTokenId,
          labelhash('sub'),
          CANNOT_SET_RESOLVER,
          500,
        ),
      ).to.be.revertedWith(`OperationProhibited("${subWrappedTokenId}")`)
    })

    it('Does not allow burning fuses if PARENT_CANNOT_CONTROL is already burned', async () => {
      await registerSetupAndWrapName('fuses', account, CANNOT_UNWRAP)

      await NameWrapper.setSubnodeOwner(wrappedTokenId, 'sub', account, 0, 0)

      const originalFuses = PARENT_CANNOT_CONTROL | CANNOT_UNWRAP

      await NameWrapper.setChildFuses(
        wrappedTokenId,
        labelhash('sub'),
        originalFuses,
        MAX_EXPIRY,
      )

      await expect(
        NameWrapper.setChildFuses(
          wrappedTokenId,
          labelhash('sub'),
          CANNOT_SET_RESOLVER | CANNOT_BURN_FUSES,
          MAX_EXPIRY,
        ),
      ).be.revertedWith(`OperationProhibited("${subWrappedTokenId}")`)
    })

    it('Does not allow burning fuses if PARENT_CANNOT_CONTROL is already burned even if PARENT_CANNOT_CONTROL is added as a fuse', async () => {
      await registerSetupAndWrapName('fuses', account, CANNOT_UNWRAP)

      await NameWrapper.setSubnodeOwner(wrappedTokenId, 'sub', account, 0, 0)

      const originalFuses = PARENT_CANNOT_CONTROL | CANNOT_UNWRAP

      await NameWrapper.setChildFuses(
        wrappedTokenId,
        labelhash('sub'),
        originalFuses,
        MAX_EXPIRY,
      )

      await expect(
        NameWrapper.setChildFuses(
          wrappedTokenId,
          labelhash('sub'),
          PARENT_CANNOT_CONTROL |
            CANNOT_UNWRAP |
            CANNOT_SET_RESOLVER |
            CANNOT_BURN_FUSES,
          MAX_EXPIRY,
        ),
      ).be.revertedWith(`OperationProhibited("${subWrappedTokenId}")`)
    })

    it('Does not allow burning PARENT_CANNOT_CONTROL if CU on the parent is not burned', async () => {
      await registerSetupAndWrapName('fuses', account, CAN_DO_EVERYTHING)

      await NameWrapper.setSubnodeOwner(wrappedTokenId, 'sub', account, 0, 0)

      const originalFuses = PARENT_CANNOT_CONTROL | CANNOT_UNWRAP

      await expect(
        NameWrapper.setChildFuses(
          wrappedTokenId,
          labelhash('sub'),
          originalFuses,
          MAX_EXPIRY,
        ),
      ).be.revertedWith(`OperationProhibited("${subWrappedTokenId}")`)
    })

    it('Fuses and owner are set to 0 if expired', async () => {
      await registerSetupAndWrapName('fuses', account, CANNOT_UNWRAP)

      await NameWrapper.setSubnodeOwner(wrappedTokenId, 'sub', account, 0, 0)

      await NameWrapper.setChildFuses(
        wrappedTokenId,
        labelhash('sub'),
        PARENT_CANNOT_CONTROL | CANNOT_UNWRAP | CANNOT_SET_RESOLVER,
        0,
      )
      ;[owner, fuses, expiry] = await NameWrapper.getData(subWrappedTokenId)

      expect(fuses).to.equal(0)
      expect(expiry).to.equal(0)
      expect(owner).to.equal(EMPTY_ADDRESS)
    })

    it('Fuses and owner are set to 0 if expired and fuses can be reset after, but owner remains burnt', async () => {
      await registerSetupAndWrapName('fuses', account, CANNOT_UNWRAP)

      await NameWrapper.setSubnodeOwner(wrappedTokenId, 'sub', account, 0, 0)

      await NameWrapper.setChildFuses(
        wrappedTokenId,
        labelhash('sub'),
        PARENT_CANNOT_CONTROL | CANNOT_UNWRAP,
        0,
      )
      ;[owner, fuses, expiry] = await NameWrapper.getData(subWrappedTokenId)

      expect(fuses).to.equal(0)
      expect(expiry).to.equal(0)
      expect(owner).to.equal(EMPTY_ADDRESS)

      const block = await ethers.provider.getBlock('latest')

      await NameWrapper.setChildFuses(
        wrappedTokenId,
        labelhash('sub'),
        PARENT_CANNOT_CONTROL | CANNOT_UNWRAP,
        block.timestamp + 1 * DAY,
      )
      ;[owner2, fuses2, expiry2] = await NameWrapper.getData(subWrappedTokenId)

      expect(owner2).to.equal(EMPTY_ADDRESS)
      expect(fuses2).to.equal(PARENT_CANNOT_CONTROL | CANNOT_UNWRAP)
      expect(expiry2).to.equal(block.timestamp + 1 * DAY)
    })
  })

  describe('setSubnodeOwner()', async () => {
    const label = 'ownerandwrap'
    const wrappedTokenId = namehash(label + '.arb')

    before(async () => {
      await registerSetupAndWrapName(label, account, CANNOT_UNWRAP)
    })

    it('Can be called by the owner of a name and sets this contract as owner on the ENS registry.', async () => {
      expect(await NameWrapper.ownerOf(wrappedTokenId)).to.equal(account)
      await EnsRegistry.setApprovalForAll(NameWrapper.address, true)
      await NameWrapper.setSubnodeOwner(
        wrappedTokenId,
        'sub',
        account,
        CAN_DO_EVERYTHING,
        0,
      )

      expect(await EnsRegistry.owner(namehash(`sub.${label}.arb`))).to.equal(
        NameWrapper.address,
      )

      expect(await NameWrapper.ownerOf(namehash(`sub.${label}.arb`))).to.equal(
        account,
      )
    })
    it('Can be called by an account authorised by the owner.', async () => {
      expect(await NameWrapper.ownerOf(wrappedTokenId)).to.equal(account)
      await NameWrapper.setApprovalForAll(account2, true)
      await NameWrapper2.setSubnodeOwner(wrappedTokenId, 'sub', account, 0, 0)

      expect(await EnsRegistry.owner(namehash(`sub.${label}.arb`))).to.equal(
        NameWrapper.address,
      )

      expect(await NameWrapper.ownerOf(namehash(`sub.${label}.arb`))).to.equal(
        account,
      )
    })
    it('Transfers the wrapped token to the target address.', async () => {
      expect(await NameWrapper.ownerOf(wrappedTokenId)).to.equal(account)
      await NameWrapper.setSubnodeOwner(
        wrappedTokenId,
        'sub',
        account2,
        CAN_DO_EVERYTHING,
        0,
      )

      expect(await EnsRegistry.owner(namehash(`sub.${label}.arb`))).to.equal(
        NameWrapper.address,
      )

      expect(await NameWrapper.ownerOf(namehash(`sub.${label}.arb`))).to.equal(
        account2,
      )
    })
    it('Will not allow wrapping with a target address of 0x0.', async () => {
      expect(await NameWrapper.ownerOf(wrappedTokenId)).to.equal(account)
      await expect(
        NameWrapper.setSubnodeOwner(
          wrappedTokenId,
          'sub',
          EMPTY_ADDRESS,
          0,
          CAN_DO_EVERYTHING,
        ),
      ).to.be.revertedWith('ERC1155: mint to the zero address')
    })
    it('Will not allow wrapping with a target address of the wrapper contract address', async () => {
      await expect(
        NameWrapper.setSubnodeOwner(
          wrappedTokenId,
          'sub',
          NameWrapper.address,
          CAN_DO_EVERYTHING,
          0,
        ),
      ).to.be.revertedWith(
        'ERC1155: newOwner cannot be the NameWrapper contract',
      )
    })
    it('Does not allow anyone else to wrap a name even if the owner has authorised the wrapper with the ENS registry.', async () => {
      expect(await NameWrapper.ownerOf(wrappedTokenId)).to.equal(account)
      await EnsRegistry.setApprovalForAll(account2, true)
      await expect(
        NameWrapper2.setSubnodeOwner(
          wrappedTokenId,
          'sub',
          account,
          CAN_DO_EVERYTHING,
          0,
        ),
      ).to.be.revertedWith(`Unauthorised("${wrappedTokenId}", "${account2}")`)
    })
    it('Fuses cannot be burned if the name does not have PARENT_CANNOT_CONTROL burned', async () => {
      const label = 'subdomain2'
      const tokenId = labelhash(label)
      const wrappedTokenId = namehash(label + '.arb')
      const label2 = 'sub'
      await registerSetupAndWrapName(label, account, CAN_DO_EVERYTHING)
      await expect(
        NameWrapper.setSubnodeOwner(
          wrappedTokenId,
          label2,
          account,
          CANNOT_UNWRAP | CANNOT_TRANSFER,
          MAX_EXPIRY,
        ),
      ).to.be.revertedWith(
        `OperationProhibited("${namehash(`${label2}.${label}.arb`)}")`,
      )
    })
    it('Does not allow fuses to be burned if CANNOT_UNWRAP is not burned.', async () => {
      const label = 'subdomain2'
      const label2 = 'sub'
      const tokenId = labelhash(label)
      const wrappedTokenId = namehash(label + '.arb')
      await registerSetupAndWrapName(label, account, CAN_DO_EVERYTHING)
      await expect(
        NameWrapper.setSubnodeOwner(
          wrappedTokenId,
          label2,
          account,
          PARENT_CANNOT_CONTROL | CANNOT_TRANSFER,
          0,
        ),
      ).to.be.revertedWith(
        `OperationProhibited("${namehash(`${label2}.${label}.arb`)}")`,
      )
    })

    it('Allows fuses to be burned if CANNOT_UNWRAP and PARENT_CANNOT_CONTROL is burned and is not expired', async () => {
      const label = 'subdomain2'
      const tokenId = labelhash(label)
      const wrappedTokenId = namehash(label + '.arb')
      await registerSetupAndWrapName(label, account, CANNOT_UNWRAP)
      await NameWrapper.setSubnodeOwner(
        wrappedTokenId,
        'sub',
        account,
        CANNOT_UNWRAP | PARENT_CANNOT_CONTROL | CANNOT_SET_RESOLVER,
        MAX_EXPIRY,
      )

      expect(
        await NameWrapper.allFusesBurned(
          namehash(`sub.${label}.arb`),
          CANNOT_UNWRAP | PARENT_CANNOT_CONTROL | CANNOT_SET_RESOLVER,
        ),
      ).to.equal(true)
    })

    it('Does not allow IS_DOT_ETH to be burned', async () => {
      const label = 'subdomain2'
      const wrappedTokenId = namehash(label + '.arb')
      await registerSetupAndWrapName(label, account, CANNOT_UNWRAP)
      await expect(
        NameWrapper.setSubnodeOwner(
          wrappedTokenId,
          'sub',
          account,
          CANNOT_UNWRAP |
            PARENT_CANNOT_CONTROL |
            CANNOT_SET_RESOLVER |
            IS_DOT_ETH,
          MAX_EXPIRY,
        ),
      ).to.be.revertedWith(
        `OperationProhibited("${namehash(`sub.${label}.arb`)}")`,
      )
    })

    it('Does not allow fuses to be burned if CANNOT_UNWRAP and PARENT_CANNOT_CONTROL are burned, but the name is expired', async () => {
      const label = 'subdomain2'
      const wrappedTokenId = namehash(label + '.arb')
      await registerSetupAndWrapName(
        label,
        account,
        CAN_DO_EVERYTHING | CANNOT_UNWRAP,
      )
      const [, parentFuses, expiry] = await NameWrapper.getData(wrappedTokenId)
      expect(parentFuses).to.equal(
        PARENT_CANNOT_CONTROL | CANNOT_UNWRAP | IS_DOT_ETH,
      )
      await NameWrapper.setSubnodeOwner(
        wrappedTokenId,
        'sub',
        account,
        CANNOT_UNWRAP | PARENT_CANNOT_CONTROL,
        0, // set expiry to 0
      )

      expect(
        await NameWrapper.allFusesBurned(
          namehash(`sub.${label}.arb`),
          PARENT_CANNOT_CONTROL,
        ),
      ).to.equal(false)
    })

    it("normalises the max expiry of a subdomain to the parent's expiry", async () => {
      const label = 'subdomain2'
      const tokenId = labelhash(label)
      const wrappedTokenId = namehash(label + '.arb')
      await registerSetupAndWrapName(
        label,
        account,
        CAN_DO_EVERYTHING | CANNOT_UNWRAP,
      )
      const expectedExpiry = await BaseRegistrar.nameExpires(tokenId)
      await NameWrapper.setSubnodeOwner(
        wrappedTokenId,
        'sub',
        account,
        CANNOT_UNWRAP | PARENT_CANNOT_CONTROL,
        MAX_EXPIRY,
      )

      const [, , expiry] = await NameWrapper.getData(
        namehash(`sub.${label}.arb`),
      )

      expect(expiry).to.equal(expectedExpiry.add(GRACE_PERIOD))
    })

    it('Emits Wrap event', async () => {
      expect(await NameWrapper.ownerOf(wrappedTokenId)).to.equal(account)
      const tx = await NameWrapper.setSubnodeOwner(
        wrappedTokenId,
        'sub',
        account2,
        0,
        0,
      )
      await expect(tx)
        .to.emit(NameWrapper, 'NameWrapped')
        .withArgs(
          namehash(`sub.${label}.arb`),
          encodeName(`sub.${label}.arb`),
          account2,
          0,
          0,
        )
    })

    it('Emits TransferSingle event', async () => {
      expect(await NameWrapper.ownerOf(wrappedTokenId)).to.equal(account)
      const tx = await NameWrapper.setSubnodeOwner(
        wrappedTokenId,
        'sub',
        account2,
        0,
        0,
      )
      await expect(tx)
        .to.emit(NameWrapper, 'TransferSingle')
        .withArgs(
          account,
          EMPTY_ADDRESS,
          account2,
          namehash(`sub.${label}.arb`),
          1,
        )
    })

    it('Will not create a subdomain with an empty label', async () => {
      await EnsRegistry.setApprovalForAll(NameWrapper.address, true)
      await expect(
        NameWrapper.setSubnodeOwner(
          wrappedTokenId,
          '',
          account,
          CAN_DO_EVERYTHING,
          0,
        ),
      ).to.be.revertedWith(`LabelTooShort()`)
    })

    it('should be able to call twice and change the owner', async () => {
      await NameWrapper.setSubnodeOwner(wrappedTokenId, 'sub', account, 0, 0)
      expect(await NameWrapper.ownerOf(namehash(`sub.${label}.arb`))).to.equal(
        account,
      )
      await NameWrapper.setSubnodeOwner(wrappedTokenId, 'sub', account2, 0, 0)
      expect(await NameWrapper.ownerOf(namehash(`sub.${label}.arb`))).to.equal(
        account2,
      )
    })

    it('setting owner to 0 burns and unwraps', async () => {
      const label = 'test'
      const wrappedTokenId = namehash(label + '.arb')
      const subLabel = 'sub'
      const subWrappedTokenId = namehash(`${subLabel}.${label}.arb`)
      await registerSetupAndWrapName(label, account, CANNOT_UNWRAP, MAX_EXPIRY)
      // Confirm that the name is wrapped
      expect(await NameWrapper.ownerOf(wrappedTokenId)).to.equal(account)
      // NameWrapper.setSubnodeOwner to account2
      await NameWrapper.setSubnodeOwner(
        wrappedTokenId,
        subLabel,
        account2,
        0,
        MAX_EXPIRY,
      )

      tx = await NameWrapper.setSubnodeOwner(
        wrappedTokenId,
        subLabel,
        EMPTY_ADDRESS,
        PARENT_CANNOT_CONTROL,
        MAX_EXPIRY,
      )

      expect(await NameWrapper.ownerOf(subWrappedTokenId)).to.equal(
        EMPTY_ADDRESS,
      )

      await expect(tx)
        .to.emit(NameWrapper, 'NameUnwrapped')
        .withArgs(subWrappedTokenId, EMPTY_ADDRESS)
    })

    it('Unwrapping within an external contract does not create any state inconsistencies', async () => {
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)
      await EnsRegistry.setApprovalForAll(NameWrapper.address, true)

      await BaseRegistrar.register(labelhash('test'), account, 1 * DAY)
      await NameWrapper.wrapETH2LD(
        'test',
        account,
        CAN_DO_EVERYTHING,
        EMPTY_ADDRESS,
      )

      const testReentrancy = await deploy(
        'TestNameWrapperReentrancy',
        account,
        NameWrapper.address,
        namehash('test.arb'),
        labelhash('sub'),
      )
      await NameWrapper.setApprovalForAll(testReentrancy.address, true)

      // set self as sub.test.arb owner
      await NameWrapper.setSubnodeOwner(
        namehash('test.arb'),
        'sub',
        account,
        CAN_DO_EVERYTHING,
        MAX_EXPIRY,
      )

      // attempt to move owner to testReentrancy, which unwraps domain itself to account while keeping ERC1155 to testReentrancy
      await expect(
        NameWrapper.setSubnodeOwner(
          namehash('test.arb'),
          'sub',
          testReentrancy.address,
          CANNOT_UNWRAP | PARENT_CANNOT_CONTROL,
          MAX_EXPIRY,
        ),
      ).to.be.reverted

      // reverts because CANNOT_UNWRAP/PCC are burned first, and then unwrap is attempted inside contract, which fails, because CU has already been burned
    })

    it('Unwrapping a previously wrapped unexpired name retains PCC and so reverts setSubnodeRecord', async () => {
      const label = 'test'
      const labelHash = labelhash(label)
      const wrappedTokenId = namehash(label + '.arb')
      const subLabel = 'sub'
      const subLabelHash = labelhash(subLabel)
      const subWrappedTokenId = namehash(`${subLabel}.${label}.arb`)
      await registerSetupAndWrapName(label, account, CANNOT_UNWRAP)
      // Confirm that the name is wrapped

      const parentExpiry = await BaseRegistrar.nameExpires(labelHash)
      expect(await NameWrapper.ownerOf(wrappedTokenId)).to.equal(account)
      // NameWrapper.setSubnodeOwner to account2
      await NameWrapper.setSubnodeOwner(
        wrappedTokenId,
        subLabel,
        account2,
        PARENT_CANNOT_CONTROL,
        MAX_EXPIRY,
      )
      // Confirm fuses are set
      const [, fusesBefore] = await NameWrapper.getData(subWrappedTokenId)
      expect(fusesBefore).to.equal(PARENT_CANNOT_CONTROL)
      await NameWrapper2.unwrap(wrappedTokenId, subLabelHash, account2)
      const [owner, fuses, expiry] = await NameWrapper.getData(
        subWrappedTokenId,
      )
      expect(owner).to.equal(EMPTY_ADDRESS)
      expect(expiry).to.equal(parentExpiry.add(GRACE_PERIOD))
      expect(fuses).to.equal(PARENT_CANNOT_CONTROL)
      await expect(
        NameWrapper.setSubnodeOwner(wrappedTokenId, subLabel, account2, 0, 0),
      ).to.be.revertedWith(`OperationProhibited("${subWrappedTokenId}")`)
    })

    it('Rewrapping a name that had PCC burned, but has now expired is possible and resets fuses', async () => {
      const label = 'test'
      const labelHash = labelhash(label)
      const wrappedTokenId = namehash(label + '.arb')
      const subLabel = 'sub'
      const subLabelHash = labelhash(subLabel)
      const subWrappedTokenId = namehash(`${subLabel}.${label}.arb`)
      await registerSetupAndWrapName(label, account, CANNOT_UNWRAP)
      // Confirm that the name is wrapped

      const parentExpiry = await BaseRegistrar.nameExpires(labelHash)
      expect(await NameWrapper.ownerOf(wrappedTokenId)).to.equal(account)
      // NameWrapper.setSubnodeOwner to account2
      await NameWrapper.setSubnodeOwner(
        wrappedTokenId,
        subLabel,
        account2,
        PARENT_CANNOT_CONTROL,
        parentExpiry - DAY / 2,
      )
      // Confirm fuses are set
      const [, fusesBefore] = await NameWrapper.getData(subWrappedTokenId)
      expect(fusesBefore).to.equal(PARENT_CANNOT_CONTROL)
      await NameWrapper2.unwrap(wrappedTokenId, subLabelHash, account2)
      const [owner, fuses, expiry] = await NameWrapper.getData(
        subWrappedTokenId,
      )

      expect(owner).to.equal(EMPTY_ADDRESS)
      expect(expiry).to.equal(parentExpiry - DAY / 2)
      expect(fuses).to.equal(PARENT_CANNOT_CONTROL)

      // Advance time so the subdomain expires, but not the parent
      await evm.advanceTime(DAY / 2 + 1)
      await evm.mine()

      const [, fusesAfter, expiryAfter] = await NameWrapper.getData(
        subWrappedTokenId,
      )
      expect(expiryAfter).to.equal(parentExpiry - DAY / 2)
      expect(fusesAfter).to.equal(0)
      await NameWrapper.setSubnodeOwner(
        wrappedTokenId,
        subLabel,
        account2,
        0,
        0,
      )

      const block1 = await ethers.provider.getBlock(
        await ethers.provider.getBlockNumber(),
      )

      const owner3 = await NameWrapper.ownerOf(subWrappedTokenId)
      const [rawOwner, rawFuses, expiry2] = await NameWrapper.getData(
        subWrappedTokenId,
      )
      const [, activeFuses] = await NameWrapper.getData(subWrappedTokenId)
      expect(activeFuses).to.equal(0)
      expect(rawFuses).to.equal(0)
      expect(rawOwner).to.equal(account2)
      expect(expiry2).to.be.below(block1.timestamp)
      expect(owner3).to.equal(account2)
    })
  })

  describe('setSubnodeRecord()', async () => {
    const label = 'subdomain2'
    const tokenId = labelhash(label)
    const wrappedTokenId = namehash(label + '.arb')
    let resolver

    before(async () => {
      resolver = account // dummy address for resolver
      await registerSetupAndWrapName(label, account, CANNOT_UNWRAP)
    })

    it('Can be called by the owner of a name', async () => {
      expect(await NameWrapper.ownerOf(wrappedTokenId)).to.equal(account)
      await NameWrapper.setSubnodeRecord(
        wrappedTokenId,
        'sub',
        account,
        resolver,
        0,
        0,
        0,
      )

      expect(await EnsRegistry.owner(namehash(`sub.${label}.arb`))).to.equal(
        NameWrapper.address,
      )

      expect(await NameWrapper.ownerOf(namehash(`sub.${label}.arb`))).to.equal(
        account,
      )
    })

    it('Can be called by an account authorised by the owner.', async () => {
      expect(await NameWrapper.ownerOf(wrappedTokenId)).to.equal(account)
      await NameWrapper.setApprovalForAll(account2, true)
      await NameWrapper2.setSubnodeRecord(
        wrappedTokenId,
        'sub',
        account,
        resolver,
        0,
        0,
        0,
      )

      expect(await EnsRegistry.owner(namehash(`sub.${label}.arb`))).to.equal(
        NameWrapper.address,
      )

      expect(await NameWrapper.ownerOf(namehash(`sub.${label}.arb`))).to.equal(
        account,
      )
    })

    it('Transfers the wrapped token to the target address.', async () => {
      await NameWrapper.setSubnodeRecord(
        wrappedTokenId,
        'sub',
        account2,
        resolver,
        0,
        0,
        0,
      )

      expect(await NameWrapper.ownerOf(namehash(`sub.${label}.arb`))).to.equal(
        account2,
      )
    })

    it('Will not allow wrapping with a target address of 0x0', async () => {
      await expect(
        NameWrapper.setSubnodeRecord(
          wrappedTokenId,
          'sub',
          EMPTY_ADDRESS,
          resolver,
          0,
          0,
          0,
        ),
      ).to.be.revertedWith('ERC1155: mint to the zero address')
    })

    it('Will not allow wrapping with a target address of the wrapper contract address.', async () => {
      await expect(
        NameWrapper.setSubnodeRecord(
          wrappedTokenId,
          'sub',
          NameWrapper.address,
          resolver,
          0,
          0,
          0,
        ),
      ).to.be.revertedWith(
        'ERC1155: newOwner cannot be the NameWrapper contract',
      )
    })

    it('Does not allow anyone else to wrap a name even if the owner has authorised the wrapper with the ENS registry.', async () => {
      expect(await NameWrapper.ownerOf(wrappedTokenId)).to.equal(account)
      await EnsRegistry.setApprovalForAll(account2, true)
      await expect(
        NameWrapper2.setSubnodeRecord(
          wrappedTokenId,
          'sub',
          account,
          resolver,
          0,
          0,
          0,
        ),
      ).to.be.revertedWith(`Unauthorised("${wrappedTokenId}", "${account2}")`)
    })

    it('Does not allow fuses to be burned if PARENT_CANNOT_CONTROL is not burned.', async () => {
      const label = 'subdomain3'
      const tokenId = labelhash(label)
      const wrappedTokenId = namehash(label + '.arb')
      await registerSetupAndWrapName(label, account, CAN_DO_EVERYTHING)
      await expect(
        NameWrapper.setSubnodeRecord(
          wrappedTokenId,
          'sub',
          account,
          resolver,
          0,
          CANNOT_UNWRAP,
          MAX_EXPIRY,
        ),
      ).to.be.revertedWith(
        `OperationProhibited("${namehash(`sub.${label}.arb`)}")`,
      )
    })

    it('Does not allow fuses to be burned if CANNOT_UNWRAP is not burned', async () => {
      const label = 'subdomain3'
      const tokenId = labelhash(label)
      const wrappedTokenId = namehash(label + '.arb')
      await registerSetupAndWrapName(
        label,
        account,
        CAN_DO_EVERYTHING,
        MAX_EXPIRY,
      )
      await expect(
        NameWrapper.setSubnodeRecord(
          wrappedTokenId,
          'sub',
          account,
          resolver,
          0,
          PARENT_CANNOT_CONTROL | CANNOT_TRANSFER,
          MAX_EXPIRY,
        ),
      ).to.be.revertedWith(
        `OperationProhibited("${namehash(`sub.${label}.arb`)}")`,
      )
    })

    it('Fuses will remain 0 if expired', async () => {
      const label = 'subdomain3'
      const tokenId = labelhash(label)
      const wrappedTokenId = namehash(label + '.arb')
      await registerSetupAndWrapName(label, account, CANNOT_UNWRAP)
      NameWrapper.setSubnodeRecord(
        wrappedTokenId,
        'sub',
        account,
        resolver,
        0,
        PARENT_CANNOT_CONTROL | CANNOT_UNWRAP | CANNOT_TRANSFER,
        0,
      )
      const [, fuses] = await NameWrapper.getData(namehash(`sub.${label}.arb`))
      expect(fuses).to.equal(0)
    })

    it('Allows fuses to be burned if not expired and PARENT_CANNOT_CONTROL/CANNOT_UNWRAP are burned', async () => {
      const label = 'subdomain3'
      const tokenId = labelhash(label)
      const wrappedTokenId = namehash(label + '.arb')
      await registerSetupAndWrapName(label, account, CANNOT_UNWRAP, MAX_EXPIRY)
      NameWrapper.setSubnodeRecord(
        wrappedTokenId,
        'sub',
        account,
        resolver,
        0,
        PARENT_CANNOT_CONTROL | CANNOT_UNWRAP | CANNOT_TRANSFER,
        MAX_EXPIRY,
      )
      const [, fuses] = await NameWrapper.getData(namehash(`sub.${label}.arb`))
      expect(fuses).to.equal(
        PARENT_CANNOT_CONTROL | CANNOT_UNWRAP | CANNOT_TRANSFER,
      )
    })

    it('does not allow burning IS_DOT_ETH', async () => {
      const label = 'subdomain3'
      const tokenId = labelhash(label)
      const wrappedTokenId = namehash(label + '.arb')
      await registerSetupAndWrapName(label, account, CANNOT_UNWRAP)
      await expect(
        NameWrapper.setSubnodeRecord(
          wrappedTokenId,
          'sub',
          account,
          resolver,
          0,
          PARENT_CANNOT_CONTROL | CANNOT_UNWRAP | CANNOT_TRANSFER | IS_DOT_ETH,
          MAX_EXPIRY,
        ),
      ).to.be.revertedWith(
        `OperationProhibited("${namehash(`sub.${label}.arb`)}")`,
      )
    })

    it('Emits Wrap event', async () => {
      const tx = await NameWrapper.setSubnodeRecord(
        wrappedTokenId,
        'sub',
        account2,
        resolver,
        0,
        0,
        0,
      )
      await expect(tx)
        .to.emit(NameWrapper, 'NameWrapped')
        .withArgs(
          namehash(`sub.${label}.arb`),
          encodeName(`sub.${label}.arb`),
          account2,
          0,
          0,
        )
    })

    it('Emits TransferSingle event', async () => {
      const tx = await NameWrapper.setSubnodeRecord(
        wrappedTokenId,
        'sub',
        account2,
        resolver,
        0,
        0,
        0,
      )
      await expect(tx)
        .to.emit(NameWrapper, 'TransferSingle')
        .withArgs(
          account,
          EMPTY_ADDRESS,
          account2,
          namehash(`sub.${label}.arb`),
          1,
        )
    })

    it('Sets the appropriate values on the ENS registry', async () => {
      await NameWrapper.setSubnodeRecord(
        wrappedTokenId,
        'sub',
        account2,
        resolver,
        100,
        0,
        0,
      )

      const node = namehash(`sub.${label}.arb`)

      expect(await EnsRegistry.owner(node)).to.equal(NameWrapper.address)
      expect(await EnsRegistry.resolver(node)).to.equal(resolver)
      expect(await EnsRegistry.ttl(node)).to.equal(100)
    })

    it('Will not create a subdomain with an empty label', async () => {
      expect(await NameWrapper.ownerOf(wrappedTokenId)).to.equal(account)
      await expect(
        NameWrapper.setSubnodeRecord(
          wrappedTokenId,
          '',
          account,
          resolver,
          0,
          0,
          0,
        ),
      ).to.be.revertedWith(`LabelTooShort()`)
    })

    it('should be able to call twice and change the owner', async () => {
      await NameWrapper.setSubnodeRecord(
        wrappedTokenId,
        'sub',
        account,
        resolver,
        0,
        0,
        0,
      )
      expect(await NameWrapper.ownerOf(namehash(`sub.${label}.arb`))).to.equal(
        account,
      )
      await NameWrapper.setSubnodeRecord(
        wrappedTokenId,
        'sub',
        account2,
        resolver,
        0,
        0,
        0,
      )
      expect(await NameWrapper.ownerOf(namehash(`sub.${label}.arb`))).to.equal(
        account2,
      )
    })

    it('setting owner to 0 burns and unwraps', async () => {
      const label = 'test'
      const wrappedTokenId = namehash(label + '.arb')
      const subLabel = 'sub'
      const subWrappedTokenId = namehash(`${subLabel}.${label}.arb`)
      await registerSetupAndWrapName(label, account, CANNOT_UNWRAP, MAX_EXPIRY)
      // Confirm that the name is wrapped
      expect(await NameWrapper.ownerOf(wrappedTokenId)).to.equal(account)
      // NameWrapper.setSubnodeOwner to account2
      await NameWrapper.setSubnodeRecord(
        wrappedTokenId,
        subLabel,
        account2,
        EMPTY_ADDRESS,
        0,
        0,
        MAX_EXPIRY,
      )

      expect(await NameWrapper.ownerOf(subWrappedTokenId)).to.equal(account2)

      const tx = await NameWrapper.setSubnodeRecord(
        wrappedTokenId,
        subLabel,
        EMPTY_ADDRESS,
        EMPTY_ADDRESS,
        0,
        PARENT_CANNOT_CONTROL,
        MAX_EXPIRY,
      )

      expect(await NameWrapper.ownerOf(subWrappedTokenId)).to.equal(
        EMPTY_ADDRESS,
      )

      await expect(tx)
        .to.emit(NameWrapper, 'NameUnwrapped')
        .withArgs(subWrappedTokenId, EMPTY_ADDRESS)
    })

    it('Unwrapping within an external contract does not create any state inconsistencies', async () => {
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)
      await EnsRegistry.setApprovalForAll(NameWrapper.address, true)

      await BaseRegistrar.register(labelhash('test'), account, 1 * DAY)
      await NameWrapper.wrapETH2LD(
        'test',
        account,
        CAN_DO_EVERYTHING,
        EMPTY_ADDRESS,
      )

      const testReentrancy = await deploy(
        'TestNameWrapperReentrancy',
        account,
        NameWrapper.address,
        namehash('test.arb'),
        labelhash('sub'),
      )
      await NameWrapper.setApprovalForAll(testReentrancy.address, true)

      // set self as sub.test.arb owner
      await NameWrapper.setSubnodeRecord(
        namehash('test.arb'),
        'sub',
        account,
        EMPTY_ADDRESS,
        0,
        CAN_DO_EVERYTHING,
        MAX_EXPIRY,
      )

      // move owner to testReentrancy, which unwraps domain itself to account while keeping ERC1155 to testReentrancy
      await expect(
        NameWrapper.setSubnodeRecord(
          namehash('test.arb'),
          'sub',
          testReentrancy.address,
          EMPTY_ADDRESS,
          0,
          CANNOT_UNWRAP | PARENT_CANNOT_CONTROL,
          MAX_EXPIRY,
        ),
      ).to.be.reverted

      // reverts because CANNOT_UNWRAP/PCC are burned first, and then unwrap is attempted inside contract, which fails, because CU has already been burned
    })

    it('Unwrapping a previously wrapped unexpired name retains PCC and so reverts setSubnodeRecord', async () => {
      const label = 'test'
      const labelHash = labelhash(label)
      const wrappedTokenId = namehash(label + '.arb')
      const subLabel = 'sub'
      const subLabelHash = labelhash(subLabel)
      const subWrappedTokenId = namehash(`${subLabel}.${label}.arb`)
      await registerSetupAndWrapName(label, account, CANNOT_UNWRAP)
      const parentExpiry = await BaseRegistrar.nameExpires(labelHash)

      // Confirm that the name is wrapped
      expect(await NameWrapper.ownerOf(wrappedTokenId)).to.equal(account)
      // NameWrapper.setSubnodeOwner to account2
      await NameWrapper.setSubnodeOwner(
        wrappedTokenId,
        'sub',
        account2,
        PARENT_CANNOT_CONTROL,
        MAX_EXPIRY,
      )
      // Confirm fuses are set
      const [ownerBefore, fusesBefore, expiryBefore] =
        await NameWrapper.getData(subWrappedTokenId)
      expect(ownerBefore).to.equal(account2)
      expect(fusesBefore).to.equal(PARENT_CANNOT_CONTROL)
      expect(expiryBefore).to.equal(parentExpiry.add(GRACE_PERIOD))
      await NameWrapper2.unwrap(wrappedTokenId, subLabelHash, account2)
      const [owner, fuses, expiry] = await NameWrapper.getData(
        subWrappedTokenId,
      )
      expect(owner).to.equal(EMPTY_ADDRESS)
      expect(fuses).to.equal(PARENT_CANNOT_CONTROL)
      expect(expiry).to.equal(parentExpiry.add(GRACE_PERIOD))
      // attempt to rewrap with PCC still burnt
      await expect(
        NameWrapper.setSubnodeRecord(
          wrappedTokenId,
          subLabel,
          account2,
          EMPTY_ADDRESS,
          0,
          0,
          0,
        ),
      ).to.be.revertedWith(`OperationProhibited("${subWrappedTokenId}")`)
    })

    it('Rewrapping a name that had PCC burned, but has now expired is possible', async () => {
      const label = 'test'
      const labelHash = labelhash(label)
      const wrappedTokenId = namehash(label + '.arb')
      const subLabel = 'sub'
      const subLabelHash = labelhash(subLabel)
      const subWrappedTokenId = namehash(`${subLabel}.${label}.arb`)
      await registerSetupAndWrapName(label, account, CANNOT_UNWRAP)

      const parentExpiry = await BaseRegistrar.nameExpires(labelHash)
      // Confirm that the name is wrapped
      expect(await NameWrapper.ownerOf(wrappedTokenId)).to.equal(account)
      // NameWrapper.setSubnodeOwner to account2
      await NameWrapper.setSubnodeOwner(
        wrappedTokenId,
        'sub',
        account2,
        PARENT_CANNOT_CONTROL,
        parentExpiry - DAY / 2,
      )
      // Confirm fuses are set
      const [, fusesBefore] = await NameWrapper.getData(subWrappedTokenId)
      expect(fusesBefore).to.equal(PARENT_CANNOT_CONTROL)
      await NameWrapper2.unwrap(wrappedTokenId, subLabelHash, account2)

      const [owner, fuses, expiry] = await NameWrapper.getData(
        subWrappedTokenId,
      )
      expect(owner).to.equal(EMPTY_ADDRESS)
      expect(expiry).to.equal(parentExpiry - DAY / 2)
      expect(fuses).to.equal(PARENT_CANNOT_CONTROL)

      // Advance time so the subname expires, but not the parent
      await evm.advanceTime(DAY / 2 + 1)
      await evm.mine()

      const [, fusesAfter, expiryAfter] = await NameWrapper.getData(
        subWrappedTokenId,
      )
      expect(expiryAfter).to.equal(parentExpiry - DAY / 2)
      expect(fusesAfter).to.equal(0)

      await NameWrapper.setSubnodeRecord(
        wrappedTokenId,
        subLabel,
        account2,
        EMPTY_ADDRESS,
        0,
        0,
        0,
      )
    })
  })

  describe('setRecord()', () => {
    const label = 'setrecord'
    const labelHash = labelhash(label)
    const wrappedTokenId = namehash(label + '.arb')

    before(async () => {
      await registerSetupAndWrapName(label, account, CANNOT_UNWRAP)
    })

    it('Can be called by the owner', async () => {
      expect(await NameWrapper.ownerOf(wrappedTokenId)).to.equal(account)
      await NameWrapper.setRecord(wrappedTokenId, account2, account, 50)
    })

    it('Performs the appropriate function on the ENS registry and Wrapper', async () => {
      await NameWrapper.setRecord(wrappedTokenId, account2, account, 50)

      expect(await NameWrapper.ownerOf(wrappedTokenId)).to.equal(account2)
      expect(await EnsRegistry.resolver(wrappedTokenId)).to.equal(account)
      expect(await EnsRegistry.ttl(wrappedTokenId)).to.equal(50)
    })

    it('Can be called by an account authorised by the owner.', async () => {
      expect(await NameWrapper.ownerOf(wrappedTokenId)).to.equal(account)
      await NameWrapper.setApprovalForAll(account2, true)
      await NameWrapper2.setRecord(wrappedTokenId, account2, account, 50)
    })

    it('Cannot be called by anyone else.', async () => {
      await expect(
        NameWrapper2.setRecord(wrappedTokenId, account2, account, 50),
      ).to.be.revertedWith(`Unauthorised("${wrappedTokenId}", "${account2}")`)
    })

    it('Cannot be called if CANNOT_TRANSFER is burned.', async () => {
      await NameWrapper.setFuses(wrappedTokenId, CANNOT_TRANSFER)
      await expect(
        NameWrapper.setRecord(wrappedTokenId, account2, account, 50),
      ).to.be.revertedWith(`OperationProhibited("${wrappedTokenId}")`)
    })

    it('Cannot be called if CANNOT_SET_RESOLVER is burned.', async () => {
      await NameWrapper.setFuses(wrappedTokenId, CANNOT_SET_RESOLVER)

      await expect(
        NameWrapper.setRecord(wrappedTokenId, account2, account, 50),
      ).to.be.revertedWith(`OperationProhibited("${wrappedTokenId}")`)
    })

    it('Cannot be called if CANNOT_SET_TTL is burned.', async () => {
      await NameWrapper.setFuses(wrappedTokenId, CANNOT_SET_TTL)

      await expect(
        NameWrapper.setRecord(wrappedTokenId, account2, account, 50),
      ).to.be.revertedWith(`OperationProhibited("${wrappedTokenId}")`)
    })

    it('Setting the owner to 0 reverts if CANNOT_UNWRAP is burned', async () => {
      await registerSetupAndWrapName('setrecord2', account, CANNOT_UNWRAP)
      const wrappedTokenId2 = namehash('setrecord2.arb')
      const subWrappedTokenId = namehash('sub.setrecord2.arb')
      await NameWrapper.setSubnodeOwner(
        wrappedTokenId2,
        'sub',
        account,
        CANNOT_UNWRAP | PARENT_CANNOT_CONTROL,
        MAX_EXPIRY,
      )
      expect(await NameWrapper.ownerOf(subWrappedTokenId)).to.equal(account)
      await expect(
        NameWrapper.setRecord(subWrappedTokenId, EMPTY_ADDRESS, account, 50),
      ).to.be.revertedWith(`OperationProhibited("${subWrappedTokenId}")`)
    })

    it('Setting the owner of a subdomain to 0 unwraps the name and passes through resolver/ttl', async () => {
      await registerSetupAndWrapName('setrecord2', account, 0)
      const wrappedTokenId2 = namehash('setrecord2.arb')
      const subWrappedTokenId = namehash('sub.setrecord2.arb')
      await NameWrapper.setSubnodeOwner(wrappedTokenId2, 'sub', account, 0, 0)
      expect(await NameWrapper.ownerOf(subWrappedTokenId)).to.equal(account)
      const tx = await NameWrapper.setRecord(
        subWrappedTokenId,
        EMPTY_ADDRESS,
        account,
        50,
      )
      await expect(tx)
        .to.emit(NameWrapper, 'NameUnwrapped')
        .withArgs(subWrappedTokenId, EMPTY_ADDRESS)
      expect(await NameWrapper.ownerOf(subWrappedTokenId)).to.equal(
        EMPTY_ADDRESS,
      )
      expect(await EnsRegistry.owner(subWrappedTokenId)).to.equal(EMPTY_ADDRESS)
      expect(await EnsRegistry.resolver(subWrappedTokenId)).to.equal(account)
      expect(await EnsRegistry.ttl(subWrappedTokenId)).to.equal(50)
    })

    it('Setting the owner to 0 on a .arb reverts', async () => {
      await registerSetupAndWrapName('setrecord2', account, 0)
      const wrappedTokenId2 = namehash('setrecord2.arb')
      expect(await NameWrapper.ownerOf(wrappedTokenId2)).to.equal(account)
      const tx = await expect(
        NameWrapper.setRecord(wrappedTokenId2, EMPTY_ADDRESS, account, 50),
      ).to.be.revertedWith(`IncorrectTargetOwner("${EMPTY_ADDRESS}")`)
    })
  })

  describe('setResolver', () => {
    const label = 'setresolver'
    const labelHash = labelhash(label)
    const wrappedTokenId = namehash(label + '.arb')

    before(async () => {
      await registerSetupAndWrapName(label, account, CANNOT_UNWRAP)
    })

    it('Can be called by the owner', async () => {
      expect(await NameWrapper.ownerOf(wrappedTokenId)).to.equal(account)
      await NameWrapper.setResolver(wrappedTokenId, account2)
    })

    it('Performs the appropriate function on the ENS registry.', async () => {
      expect(await EnsRegistry.resolver(wrappedTokenId)).to.equal(EMPTY_ADDRESS)
      await NameWrapper.setResolver(wrappedTokenId, account2)
      expect(await EnsRegistry.resolver(wrappedTokenId)).to.equal(account2)
    })

    it('Can be called by an account authorised by the owner.', async () => {
      expect(await NameWrapper.ownerOf(wrappedTokenId)).to.equal(account)
      await NameWrapper.setApprovalForAll(account2, true)
      await NameWrapper2.setResolver(wrappedTokenId, account2)
    })

    it('Cannot be called by anyone else.', async () => {
      await expect(
        NameWrapper2.setResolver(wrappedTokenId, account2),
      ).to.be.revertedWith(`Unauthorised("${wrappedTokenId}", "${account2}")`)
    })

    it('Cannot be called if CANNOT_SET_RESOLVER is burned', async () => {
      await NameWrapper.setFuses(wrappedTokenId, CANNOT_SET_RESOLVER)

      await expect(
        NameWrapper.setResolver(wrappedTokenId, account2),
      ).to.be.revertedWith(`OperationProhibited("${wrappedTokenId}")`)
    })
  })

  describe('setTTL', () => {
    const label = 'setttl'
    const labelHash = labelhash(label)
    const wrappedTokenId = namehash(label + '.arb')

    before(async () => {
      await registerSetupAndWrapName(label, account, CANNOT_UNWRAP)
    })

    it('Can be called by the owner', async () => {
      expect(await NameWrapper.ownerOf(wrappedTokenId)).to.equal(account)
      await NameWrapper.setTTL(wrappedTokenId, 100)
    })

    it('Performs the appropriate function on the ENS registry.', async () => {
      expect(await EnsRegistry.ttl(wrappedTokenId)).to.equal(EMPTY_ADDRESS)
      await NameWrapper.setTTL(wrappedTokenId, 100)
      expect(await EnsRegistry.ttl(wrappedTokenId)).to.equal(100)
    })

    it('Can be called by an account authorised by the owner.', async () => {
      expect(await NameWrapper.ownerOf(wrappedTokenId)).to.equal(account)
      await NameWrapper.setApprovalForAll(account2, true)
      await NameWrapper2.setTTL(wrappedTokenId, 100)
    })

    it('Cannot be called by anyone else.', async () => {
      await expect(
        NameWrapper2.setTTL(wrappedTokenId, 3600),
      ).to.be.revertedWith(`Unauthorised("${wrappedTokenId}", "${account2}")`)
    })

    it('Cannot be called if CANNOT_SET_TTL is burned', async () => {
      await NameWrapper.setFuses(wrappedTokenId, CANNOT_SET_TTL)

      await expect(NameWrapper.setTTL(wrappedTokenId, 100)).to.be.revertedWith(
        `OperationProhibited("${wrappedTokenId}")`,
      )
    })
  })

  describe('onERC721Received', () => {
    const label = 'send2contract'
    const name = label + '.arb'
    const tokenId = labelhash(label)
    const wrappedTokenId = namehash(label + '.arb')
    const types = ['string', 'address', 'uint32', 'address']
    it('Wraps a name transferred to it and sets the owner to the provided address', async () => {
      await BaseRegistrar.register(tokenId, account, 1 * DAY)

      await BaseRegistrar['safeTransferFrom(address,address,uint256,bytes)'](
        account,
        NameWrapper.address,
        tokenId,
        abiCoder.encode(types, [label, account2, '0x0', EMPTY_ADDRESS]),
      )

      expect(await NameWrapper.ownerOf(wrappedTokenId)).to.equal(account2)
      expect(await BaseRegistrar.ownerOf(tokenId)).to.equal(NameWrapper.address)
    })

    it('Reverts if called by anything other than the ENS registrar address', async () => {
      await BaseRegistrar.register(tokenId, account, 1 * DAY)

      await expect(
        NameWrapper.onERC721Received(
          account,
          account,
          tokenId,
          abiCoder.encode(types, [label, account, '0x00000001', EMPTY_ADDRESS]),
        ),
      ).to.be.revertedWith('IncorrectTokenType()')
    })

    it('Accepts fuse values from the data field', async () => {
      await BaseRegistrar.register(tokenId, account, 1 * DAY)

      await BaseRegistrar['safeTransferFrom(address,address,uint256,bytes)'](
        account,
        NameWrapper.address,
        tokenId,
        abiCoder.encode(types, [label, account, '0x00000001', EMPTY_ADDRESS]),
      )
      const [, fuses] = await NameWrapper.getData(wrappedTokenId)
      expect(fuses).to.equal(CANNOT_UNWRAP | PARENT_CANNOT_CONTROL | IS_DOT_ETH)
      expect(
        await NameWrapper.allFusesBurned(wrappedTokenId, CANNOT_UNWRAP),
      ).to.equal(true)
    })

    it('Allows specifiying resolver address', async () => {
      await BaseRegistrar.register(tokenId, account, 1 * DAY)

      await BaseRegistrar['safeTransferFrom(address,address,uint256,bytes)'](
        account,
        NameWrapper.address,
        tokenId,
        abiCoder.encode(types, [label, account, '0x00000001', account2]),
      )

      expect(await EnsRegistry.resolver(wrappedTokenId)).to.equal(account2)
    })

    it('Reverts if transferred without data', async () => {
      await BaseRegistrar.register(tokenId, account, 1 * DAY)

      await expect(
        BaseRegistrar['safeTransferFrom(address,address,uint256,bytes)'](
          account,
          NameWrapper.address,
          tokenId,
          '0x',
        ),
      ).to.be.revertedWith('ERC721: transfer to non ERC721Receiver implementer')
    })
    it('Rejects transfers where the data field label does not match the tokenId', async () => {
      await BaseRegistrar.register(tokenId, account, 1 * DAY)

      await expect(
        BaseRegistrar['safeTransferFrom(address,address,uint256,bytes)'](
          account,
          NameWrapper.address,
          tokenId,
          abiCoder.encode(types, [
            'incorrectlabel',
            account,
            '0x00000000',
            EMPTY_ADDRESS,
          ]),
        ),
      ).to.be.revertedWith('LabelMismatch')
    })

    it('Reverts if CANNOT_UNWRAP is not burned and attempts to burn other fuses', async () => {
      await BaseRegistrar.register(tokenId, account, 1 * DAY)
      await EnsRegistry.setOwner(wrappedTokenId, account2)

      await expect(
        BaseRegistrar['safeTransferFrom(address,address,uint256,bytes)'](
          account,
          NameWrapper.address,
          tokenId,
          abiCoder.encode(types, [label, account, '0x00000002', EMPTY_ADDRESS]),
        ),
      ).to.be.revertedWith('OperationProhibited')
    })

    it('Reverts when manually changing fuse calldata to incorrect type', async () => {
      await BaseRegistrar.register(tokenId, account, 1 * DAY)

      const tx = await BaseRegistrar.populateTransaction[
        'safeTransferFrom(address,address,uint256,bytes)'
      ](
        account,
        NameWrapper.address,
        tokenId,
        abiCoder.encode(types, [label, account, 273, EMPTY_ADDRESS]),
      )
      const rogueFuse = '40000' // 2 ** 18 in hex
      tx.data = tx.data.replace('00111', rogueFuse)
      await expect(signers[0].sendTransaction(tx)).to.be.revertedWith(
        'ERC721: transfer to non ERC721Receiver implementer',
      )
    })

    it('Allows burning other fuses if CAN_UNWRAP has been burnt', async () => {
      await BaseRegistrar.register(tokenId, account, 1 * DAY)
      await EnsRegistry.setOwner(wrappedTokenId, account2)

      await BaseRegistrar['safeTransferFrom(address,address,uint256,bytes)'](
        account,
        NameWrapper.address,
        tokenId,
        abiCoder.encode(
          types,
          [label, account, 5, EMPTY_ADDRESS], // CANNOT_UNWRAP | CANNOT_TRANSFER
        ),
      )

      expect(await EnsRegistry.owner(wrappedTokenId)).to.equal(
        NameWrapper.address,
      )
      expect(await NameWrapper.ownerOf(wrappedTokenId)).to.equal(account)

      expect((await NameWrapper.getData(wrappedTokenId))[1]).to.equal(
        CANNOT_UNWRAP | CANNOT_TRANSFER | PARENT_CANNOT_CONTROL | IS_DOT_ETH,
      )

      expect(
        await NameWrapper.allFusesBurned(
          wrappedTokenId,
          CANNOT_UNWRAP | CANNOT_TRANSFER | PARENT_CANNOT_CONTROL,
        ),
      ).to.equal(true)
    })

    it('Allows burning other fuses if CAN_UNWRAP has been burnt, but resets fuses if expired', async () => {
      await BaseRegistrar.register(tokenId, account, 1 * DAY)
      await EnsRegistry.setOwner(wrappedTokenId, account2)

      await BaseRegistrar['safeTransferFrom(address,address,uint256,bytes)'](
        account,
        NameWrapper.address,
        tokenId,
        abiCoder.encode(types, [
          label,
          account,
          CANNOT_UNWRAP | CANNOT_TRANSFER,
          EMPTY_ADDRESS,
        ]),
      )

      await evm.advanceTime(GRACE_PERIOD + 1 * DAY)
      await evm.mine()

      expect(await EnsRegistry.owner(wrappedTokenId)).to.equal(
        NameWrapper.address,
      )

      const [, fuses] = await NameWrapper.getData(wrappedTokenId)
      const owner = await NameWrapper.ownerOf(wrappedTokenId)
      // owner should be 0 as expired
      expect(owner).to.equal(EMPTY_ADDRESS)
      expect(fuses).to.equal(0)

      expect(
        await NameWrapper.allFusesBurned(
          wrappedTokenId,
          CANNOT_UNWRAP | PARENT_CANNOT_CONTROL | CANNOT_TRANSFER,
        ),
      ).to.equal(false)
    })

    it('Sets the controller in the ENS registry to the wrapper contract', async () => {
      await BaseRegistrar.register(tokenId, account, 1 * DAY)

      await BaseRegistrar['safeTransferFrom(address,address,uint256,bytes)'](
        account,
        NameWrapper.address,
        tokenId,
        abiCoder.encode(types, [label, account, '0x00000000', EMPTY_ADDRESS]),
      )

      expect(await EnsRegistry.owner(wrappedTokenId)).to.equal(
        NameWrapper.address,
      )
    })
    it('Can wrap a name even if the controller address is different to the registrant address', async () => {
      await BaseRegistrar.register(tokenId, account, 1 * DAY)
      await EnsRegistry.setOwner(wrappedTokenId, account2)

      await BaseRegistrar['safeTransferFrom(address,address,uint256,bytes)'](
        account,
        NameWrapper.address,
        tokenId,
        abiCoder.encode(
          types,
          ['send2contract', account, '0x00000000', EMPTY_ADDRESS], // CANNOT_UNWRAP | CANNOT_TRANSFER
        ),
      )

      expect(await EnsRegistry.owner(wrappedTokenId)).to.equal(
        NameWrapper.address,
      )
      expect(await NameWrapper.ownerOf(wrappedTokenId)).to.equal(account)
    })

    it('emits NameWrapped Event', async () => {
      await BaseRegistrar.register(tokenId, account, 1 * DAY)
      const expectedExpiry = await BaseRegistrar.nameExpires(tokenId)
      const tx = await BaseRegistrar[
        'safeTransferFrom(address,address,uint256,bytes)'
      ](
        account,
        NameWrapper.address,
        tokenId,
        abiCoder.encode(
          types,
          [label, account, 5, EMPTY_ADDRESS], // CANNOT_UNWRAP | CANNOT_TRANSFER
        ),
      )

      await expect(tx)
        .to.emit(NameWrapper, 'NameWrapped')
        .withArgs(
          wrappedTokenId,
          encodeName(name),
          account,
          CANNOT_UNWRAP | CANNOT_TRANSFER | PARENT_CANNOT_CONTROL | IS_DOT_ETH,
          expectedExpiry.add(GRACE_PERIOD),
        )
    })

    it('emits TransferSingle Event', async () => {
      await BaseRegistrar.register(tokenId, account, 1 * DAY)
      const tx = await BaseRegistrar[
        'safeTransferFrom(address,address,uint256,bytes)'
      ](
        account,
        NameWrapper.address,
        tokenId,
        abiCoder.encode(
          types,
          [label, account, 5, EMPTY_ADDRESS], // CANNOT_UNWRAP | CANNOT_TRANSFER
        ),
      )

      await expect(tx)
        .to.emit(NameWrapper, 'TransferSingle')
        .withArgs(
          BaseRegistrar.address,
          EMPTY_ADDRESS,
          account,
          wrappedTokenId,
          1,
        )
    })

    it('will not wrap a name with an empty label', async () => {
      await BaseRegistrar.register(labelhash(''), account, 1 * DAY)

      await expect(
        BaseRegistrar['safeTransferFrom(address,address,uint256,bytes)'](
          account,
          NameWrapper.address,
          labelhash(''),
          abiCoder.encode(types, ['', account, 0, EMPTY_ADDRESS]),
        ),
      ).to.be.revertedWith('LabelTooShort')
    })
  })

  describe('Transfer', () => {
    const label = 'transfer'
    const labelHash = labelhash(label)
    const wrappedTokenId = namehash(label + '.arb')

    before(async () => {
      await registerSetupAndWrapName(label, account, CANNOT_UNWRAP)
    })

    it('safeTransfer cannot be called if CANNOT_TRANSFER is burned and is not expired', async () => {
      await NameWrapper.setFuses(wrappedTokenId, CANNOT_TRANSFER)

      await expect(
        NameWrapper.safeTransferFrom(
          account,
          account2,
          wrappedTokenId,
          1,
          '0x',
        ),
      ).to.be.revertedWith(`OperationProhibited("${wrappedTokenId}")`)
    })

    it('safeBatchTransfer cannot be called if CANNOT_TRANSFER is burned and is not expired', async () => {
      await NameWrapper.setFuses(wrappedTokenId, CANNOT_TRANSFER)

      await expect(
        NameWrapper.safeBatchTransferFrom(
          account,
          account2,
          [wrappedTokenId],
          [1],
          '0x',
        ),
      ).to.be.revertedWith(`OperationProhibited("${wrappedTokenId}")`)
    })
  })

  describe('getData', () => {
    const label = 'getfuses'
    const labelHash = labelhash(label)
    const nameHash = namehash(label + '.arb')
    const subLabel = 'sub'
    const subLabelHash = labelhash(subLabel)
    const subNameHash = namehash(`${subLabel}.${label}.arb`)
    const subSubLabel = 'subsub'
    const subSubLabelhash = labelhash(subSubLabel)
    const subSubNameHash = namehash(`${subSubLabel}.${subLabel}.${label}.arb`)

    it('returns the correct fuses and expiry', async () => {
      const initialFuses = CANNOT_UNWRAP | CANNOT_SET_RESOLVER
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)
      await BaseRegistrar.register(labelHash, account, 1 * DAY)
      const expectedExpiry = await BaseRegistrar.nameExpires(labelHash)
      await NameWrapper.wrapETH2LD(label, account, initialFuses, EMPTY_ADDRESS)
      const [, fuses, expiry] = await NameWrapper.getData(nameHash)
      expect(fuses).to.equal(initialFuses | PARENT_CANNOT_CONTROL | IS_DOT_ETH)
      expect(expiry).to.equal(expectedExpiry.add(GRACE_PERIOD))
    })

    it('clears fuses when domain is expired', async () => {
      const initialFuses = PARENT_CANNOT_CONTROL | CANNOT_UNWRAP
      await BaseRegistrar.setApprovalForAll(NameWrapper.address, true)
      await BaseRegistrar.register(labelHash, account, 1 * DAY)
      const expectedExpiry = await BaseRegistrar.nameExpires(labelHash)
      await NameWrapper.wrapETH2LD(label, account, CANNOT_UNWRAP, EMPTY_ADDRESS)
      await EnsRegistry.setApprovalForAll(NameWrapper.address, true)
      await NameWrapper.setSubnodeOwner(
        nameHash,
        subLabel,
        account,
        initialFuses,
        MAX_EXPIRY,
      )

      await increaseTime(DAY + 1 + GRACE_PERIOD)
      await mine()

      let [, fuses, expiry] = await NameWrapper.getData(subNameHash)

      expect(fuses).to.equal(0)
      expect(expiry).to.equal(expectedExpiry.add(GRACE_PERIOD))
    })
  })

  describe('registerAndWrapETH2LD()', () => {
    const label = 'register'
    const labelHash = labelhash(label)
    const wrappedTokenId = namehash(label + '.arb')

    before(async () => {
      await BaseRegistrar.addController(NameWrapper.address)
      await NameWrapper.setController(account, true)
    })

    it('should register and wrap names', async () => {
      await NameWrapper.registerAndWrapETH2LD(
        label,
        account,
        86400,
        EMPTY_ADDRESS,
        CAN_DO_EVERYTHING,
      )

      expect(await BaseRegistrar.ownerOf(labelHash)).to.equal(
        NameWrapper.address,
      )
      expect(await EnsRegistry.owner(wrappedTokenId)).to.equal(
        NameWrapper.address,
      )
      expect(await NameWrapper.ownerOf(wrappedTokenId)).to.equal(account)
    })

    it('allows specifying a resolver address', async () => {
      await NameWrapper.registerAndWrapETH2LD(
        label,
        account,
        86400,
        account2,
        CAN_DO_EVERYTHING,
      )

      expect(await EnsRegistry.resolver(wrappedTokenId)).to.equal(account2)
    })

    it('does not allow non controllers to register names', async () => {
      await NameWrapper.setController(account, false)
      await expect(
        NameWrapper.registerAndWrapETH2LD(
          label,
          account,
          86400,
          EMPTY_ADDRESS,
          CAN_DO_EVERYTHING,
        ),
      ).to.be.revertedWith('Controllable: Caller is not a controller')
    })

    it('Transfers the wrapped token to the target address.', async () => {
      await NameWrapper.registerAndWrapETH2LD(
        label,
        account2,
        86400,
        EMPTY_ADDRESS,
        CAN_DO_EVERYTHING,
      )
      expect(await NameWrapper.ownerOf(wrappedTokenId)).to.equal(account2)
    })

    it('Does not allow wrapping with a target address of 0x0', async () => {
      await expect(
        NameWrapper.registerAndWrapETH2LD(
          label,
          EMPTY_ADDRESS,
          86400,
          EMPTY_ADDRESS,
          CAN_DO_EVERYTHING,
        ),
      ).to.be.revertedWith('ERC1155: mint to the zero address')
    })

    it('Does not allow wrapping with a target address of the wrapper contract address.', async () => {
      await expect(
        NameWrapper.registerAndWrapETH2LD(
          label,
          NameWrapper.address,
          86400,
          EMPTY_ADDRESS,
          CAN_DO_EVERYTHING,
        ),
      ).to.be.revertedWith(
        'ERC1155: newOwner cannot be the NameWrapper contract',
      )
    })

    it('Does not allows fuse to be burned if CANNOT_UNWRAP has not been burned.', async () => {
      await expect(
        NameWrapper.registerAndWrapETH2LD(
          label,
          account,
          86400,
          EMPTY_ADDRESS,
          CANNOT_SET_RESOLVER,
        ),
      ).to.be.revertedWith(`OperationProhibited("${namehash(label + '.arb')}")`)
    })

    it('Allows fuse to be burned if CANNOT_UNWRAP has been burned and expiry set', async () => {
      const initialFuses = CANNOT_UNWRAP | CANNOT_SET_RESOLVER
      await NameWrapper.registerAndWrapETH2LD(
        label,
        account,
        86400,
        EMPTY_ADDRESS,
        initialFuses,
      )
      const [, fuses] = await NameWrapper.getData(wrappedTokenId)
      expect(fuses).to.equal(initialFuses | PARENT_CANNOT_CONTROL | IS_DOT_ETH)
    })

    it('automatically sets PARENT_CANNOT_CONTROL and IS_DOT_ETH', async () => {
      await NameWrapper.registerAndWrapETH2LD(
        label,
        account,
        86400,
        EMPTY_ADDRESS,
        CAN_DO_EVERYTHING,
      )
      const [, fuses] = await NameWrapper.getData(wrappedTokenId)
      expect(fuses).to.equal(PARENT_CANNOT_CONTROL | IS_DOT_ETH)
    })

    it('Errors when adding a number greater than uint16 for fuses', async () => {
      const tx = await NameWrapper.populateTransaction.registerAndWrapETH2LD(
        label,
        account,
        86400,
        EMPTY_ADDRESS,
        273,
      )

      const rogueFuse = '40000' // 2 ** 18 in hex
      tx.data = tx.data.replace('00111', rogueFuse)
      try {
        await signers[0].sendTransaction(tx)
      } catch (e) {
        expect(e.message).to.equal(
          'Transaction reverted: function was called with incorrect parameters',
        )
      }
    })

    it('Errors when passing a parent-controlled fuse', async () => {
      for (let i = 0; i < 7; i++) {
        try {
          await NameWrapper.registerAndWrapETH2LD(
            label,
            account,
            86400,
            EMPTY_ADDRESS,
            IS_DOT_ETH * 2 ** i,
          )
        } catch (e) {
          expect(e.reason).to.equal('value out-of-bounds')
        }
      }
    })

    it('Will not wrap a name with an empty label', async () => {
      await expect(
        NameWrapper.registerAndWrapETH2LD(
          '',
          account,
          86400,
          EMPTY_ADDRESS,
          CAN_DO_EVERYTHING,
        ),
      ).to.be.revertedWith(`LabelTooShort()`)
    })

    it('Will not wrap a name with a label more than 255 characters', async () => {
      const longString =
        'yutaioxtcsbzrqhdjmltsdfkgomogohhcchjoslfhqgkuhduhxqsldnurwrrtoicvthwxytonpcidtnkbrhccaozdtoznedgkfkifsvjukxxpkcmgcjprankyzerzqpnuteuegtfhqgzcxqwttyfewbazhyilqhyffufxrookxrnjkmjniqpmntcbrowglgdpkslzechimsaonlcvjkhhvdvkvvuztihobmivifuqtvtwinljslusvhhbwhuhzty'
      expect(longString.length).to.equal(256)
      await expect(
        NameWrapper.registerAndWrapETH2LD(
          longString,
          account,
          86400,
          EMPTY_ADDRESS,
          CAN_DO_EVERYTHING,
        ),
      ).to.be.revertedWith(`LabelTooLong("${longString}")`)
    })

    it('emits Wrap event', async () => {
      const tx = await NameWrapper.registerAndWrapETH2LD(
        label,
        account,
        86400,
        EMPTY_ADDRESS,
        CAN_DO_EVERYTHING,
      )

      const expiry = await BaseRegistrar.nameExpires(labelhash(label))
      await expect(tx)
        .to.emit(NameWrapper, 'NameWrapped')
        .withArgs(
          wrappedTokenId,
          encodeName('register.arb'),
          account,
          PARENT_CANNOT_CONTROL | IS_DOT_ETH,
          expiry.add(GRACE_PERIOD),
        )
    })

    it('Emits TransferSingle event', async () => {
      const tx = await NameWrapper.registerAndWrapETH2LD(
        label,
        account,
        86400,
        EMPTY_ADDRESS,
        CAN_DO_EVERYTHING,
      )
      await expect(tx)
        .to.emit(NameWrapper, 'TransferSingle')
        .withArgs(account, EMPTY_ADDRESS, account, wrappedTokenId, 1)
    })
  })

  describe('renew()', () => {
    const label = 'register'
    const labelHash = labelhash(label)
    const wrappedTokenId = namehash(label + '.arb')

    before(async () => {
      await BaseRegistrar.addController(NameWrapper.address)
      await NameWrapper.setController(account, true)
    })

    it('Renews names', async () => {
      await NameWrapper.registerAndWrapETH2LD(
        label,
        account,
        86400,
        EMPTY_ADDRESS,
        CAN_DO_EVERYTHING,
      )
      const expires = await BaseRegistrar.nameExpires(labelHash)
      await NameWrapper.renew(labelHash, 86400)
      expect(await BaseRegistrar.nameExpires(labelHash)).to.equal(
        expires.toNumber() + 86400,
      )
    })

    it('Renews names and can extend wrapper expiry', async () => {
      await NameWrapper.registerAndWrapETH2LD(
        label,
        account,
        86400,
        EMPTY_ADDRESS,
        CAN_DO_EVERYTHING,
      )
      const expires = await BaseRegistrar.nameExpires(labelHash)
      const expectedExpiry = expires.toNumber() + 86400
      await NameWrapper.renew(labelHash, 86400)
      expect(await BaseRegistrar.nameExpires(labelHash)).to.equal(
        expires.toNumber() + 86400,
      )
      const [owner, , expiry] = await NameWrapper.getData(wrappedTokenId)

      expect(expiry).to.equal(expectedExpiry + GRACE_PERIOD)
      expect(owner).to.equal(account)
    })

    it('Renewing name less than required to unexpire it still has original owner/fuses', async () => {
      await NameWrapper.registerAndWrapETH2LD(
        label,
        account,
        DAY,
        EMPTY_ADDRESS,
        CANNOT_UNWRAP | CANNOT_SET_RESOLVER,
      )

      await evm.advanceTime(DAY * 2)
      await mine()

      const [, , expiryBefore] = await NameWrapper.getData(wrappedTokenId)
      const block1 = await ethers.provider.getBlock('latest')

      //confirm expired
      expect(expiryBefore).to.be.at.most(block1.timestamp + GRACE_PERIOD)

      //renew for less than the grace period
      await NameWrapper.renew(labelHash, 1 * DAY)

      const [ownerAfter, fusesAfter, expiryAfter] = await NameWrapper.getData(
        wrappedTokenId,
      )
      expect(ownerAfter).to.equal(account)
      // fuses remain the same
      expect(fusesAfter).to.equal(
        CANNOT_UNWRAP |
          CANNOT_SET_RESOLVER |
          IS_DOT_ETH |
          PARENT_CANNOT_CONTROL,
      )
      // still expired
      expect(expiryAfter).to.be.at.most(block1.timestamp + GRACE_PERIOD)
    })
  })

  describe('Controllable', () => {
    it('allows the owner to add and remove controllers', async () => {
      const tx = await NameWrapper.setController(account, true)
      expect(tx)
        .to.emit(NameWrapper, 'ControllerChanged')
        .withArgs(account, true)

      const tx2 = await NameWrapper.setController(account, false)
      expect(tx2)
        .to.emit(NameWrapper, 'ControllerChanged')
        .withArgs(account, false)
    })

    it('does not allow non-owners to add or remove controllers', async () => {
      await NameWrapper.setController(account, true)

      await expect(NameWrapper2.setController(account2, true)).to.be.reverted
      await expect(NameWrapper2.setController(account, false)).to.be.reverted
    })
  })

  describe('MetadataService', () => {
    it('uri() returns url', async () => {
      expect(await NameWrapper.uri(123)).to.equal('https://ens.domains')
    })

    it('owner can set a new MetadataService', async () => {
      await NameWrapper.setMetadataService(account2)
      expect(await NameWrapper.metadataService()).to.equal(account2)
    })

    it('non-owner cannot set a new MetadataService', async () => {
      await expect(
        NameWrapper2.setMetadataService(account2),
      ).to.be.revertedWith('Ownable: caller is not the owner')
    })
  })

  describe('NameWrapper.names preimage dictionary', () => {
    it('Does not allow manipulating the preimage db by manually setting owner as NameWrapper', async () => {
      const label = 'base'
      const labelHash = labelhash(label)
      const wrappedTokenId = namehash(label + '.arb')
      await BaseRegistrar.register(labelHash, hacker, 1 * DAY)
      await BaseRegistrarH.setApprovalForAll(NameWrapper.address, true)
      await NameWrapperH.wrapETH2LD(label, hacker, CANNOT_UNWRAP, EMPTY_ADDRESS)
      expect(await BaseRegistrar.ownerOf(labelHash)).to.equal(
        NameWrapper.address,
      )
      expect(await EnsRegistry.owner(wrappedTokenId)).to.equal(
        NameWrapper.address,
      )
      expect(await NameWrapper.ownerOf(wrappedTokenId)).to.equal(hacker)

      // signed a submomain for the hacker, with a soon-expired expiry
      const sub1Label = 'sub1'
      const sub1LabelHash = labelhash(sub1Label)
      const sub1Domain = sub1Label + '.' + label + '.arb' // sub1.base.arb
      const wrappedSub1TokenId = namehash(sub1Domain)
      const block = await ethers.provider.getBlock(
        await ethers.provider.getBlockNumber(),
      )
      await NameWrapperH.setSubnodeOwner(
        wrappedTokenId,
        sub1Label,
        hacker,
        0,
        block.timestamp + 3600, // soonly expired
      )
      expect(await EnsRegistry.owner(wrappedSub1TokenId)).to.equal(
        NameWrapper.address,
      )
      expect(await NameWrapper.ownerOf(wrappedSub1TokenId)).to.equal(hacker)
      expect((await NameWrapper.getData(wrappedSub1TokenId))[1]).to.equal(0)

      // the hacker unwraps his wrappedSubTokenId
      await evm.advanceTime(7200)
      await NameWrapperH.unwrap(wrappedTokenId, sub1LabelHash, hacker)
      expect(await EnsRegistry.owner(wrappedSub1TokenId)).to.equal(hacker)

      // the hacker setSubnodeOwner, to set the owner of wrappedSub2TokenId as NameWrapper
      const sub2Label = 'sub2'
      const sub2LabelHash = labelhash(sub2Label)
      const sub2Domain = sub2Label + '.' + sub1Domain // sub2.sub1.base.arb
      const wrappedSub2TokenId = namehash(sub2Domain)
      await EnsRegistryH.setSubnodeOwner(
        wrappedSub1TokenId,
        sub2LabelHash,
        NameWrapper.address,
      )
      expect(await EnsRegistry.owner(wrappedSub2TokenId)).to.equal(
        NameWrapper.address,
      )

      // the hacker re-wraps the sub1node
      await EnsRegistryH.setApprovalForAll(NameWrapper.address, true)
      await NameWrapperH.wrap(encodeName(sub1Domain), hacker, EMPTY_ADDRESS)
      expect(await NameWrapper.ownerOf(wrappedSub1TokenId)).to.equal(hacker)

      // the hackers setSubnodeOwner
      // XXX: till now, the hacker gets sub2Domain with no name in Namewrapper
      await NameWrapperH.setSubnodeOwner(
        wrappedSub1TokenId,
        sub2Label,
        hacker,
        CAN_DO_EVERYTHING,
        MAX_EXPIRY,
      )
      expect(await NameWrapper.ownerOf(wrappedSub2TokenId)).to.equal(hacker)
      expect(await NameWrapper.names(wrappedSub2TokenId)).to.equal(
        encodeName(sub2Domain),
      )
      expect(await NameWrapper.names(wrappedSub2TokenId)).to.equal(
        encodeName(sub2Domain),
      )

      // the hacker forge a fake root node
      const sub3Label = 'arb'
      const sub3LabelHash = labelhash(sub3Label)
      const sub3Domain = sub3Label + '.' + sub2Domain // eth.sub2.sub1.base.arb
      const wrappedSub3TokenId = namehash(sub3Domain)
      await NameWrapperH.setSubnodeOwner(
        wrappedSub2TokenId,
        sub3Label,
        hacker,
        CAN_DO_EVERYTHING,
        MAX_EXPIRY,
      )
      expect(await NameWrapper.ownerOf(wrappedSub3TokenId)).to.equal(hacker)

      expect(await NameWrapper.names(wrappedSub3TokenId)).to.equal(
        encodeName(sub3Domain),
      )
    })
  })

  describe('Grace period tests', () => {
    const label = 'test'
    const labelHash = labelhash(label)
    const wrappedTokenId = namehash(label + '.arb')
    const subLabel = 'sub'
    const subTokenId = namehash(subLabel + '.' + label + '.arb')
    let parentExpiry
    before(async () => {
      await registerSetupAndWrapName(label, account, CANNOT_UNWRAP)
      ;[, , parentExpiry] = await NameWrapper.getData(wrappedTokenId)
      // Confirm that the name is wrapped
      expect(await NameWrapper.ownerOf(wrappedTokenId)).to.equal(account)

      // create a subdomain for other tests
      await NameWrapper.setSubnodeOwner(
        wrappedTokenId,
        subLabel,
        account2,
        PARENT_CANNOT_CONTROL | CANNOT_UNWRAP,
        parentExpiry - DAY / 2,
      )
      // move .arb name to expired and be within grace period
      await evm.advanceTime(2 * DAY)
      await evm.mine()
      const [, , expiry] = await NameWrapper.getData(wrappedTokenId)

      const block = await ethers.provider.getBlock(
        await ethers.provider.getBlockNumber(),
      )

      // expect name to be expired, but inside grace period
      expect(parseInt(expiry) - GRACE_PERIOD).to.be.below(block.timestamp)
      expect(parseInt(expiry) + GRACE_PERIOD).to.be.above(block.timestamp)

      const [, , subExpiry] = await NameWrapper.getData(subTokenId)
      const block2 = await ethers.provider.getBlock(
        await ethers.provider.getBlockNumber(),
      )
      // subdomain is not expired
      expect(subExpiry).to.be.above(block2.timestamp)
    })
    it('When a .arb name is in grace period it cannot call setSubnodeOwner', async () => {
      await expect(
        NameWrapper.setSubnodeOwner(
          wrappedTokenId,
          subLabel,
          account2,
          PARENT_CANNOT_CONTROL,
          parentExpiry - DAY / 2,
        ),
      ).to.be.revertedWith(`Unauthorised("${wrappedTokenId}", "${account}")`)
    })

    it('When a .arb name is in grace period it cannot call setSubnodeRecord', async () => {
      await expect(
        NameWrapper.setSubnodeRecord(
          wrappedTokenId,
          subLabel,
          account2,
          EMPTY_ADDRESS,
          0,
          PARENT_CANNOT_CONTROL,
          parentExpiry - DAY / 2,
        ),
      ).to.be.revertedWith(`Unauthorised("${wrappedTokenId}", "${account}")`)
    })

    it('When a .arb name is in grace period it cannot call setRecord', async () => {
      await expect(
        NameWrapper.setRecord(wrappedTokenId, account2, EMPTY_ADDRESS, 0),
      ).to.be.revertedWith(`Unauthorised("${wrappedTokenId}", "${account}")`)
    })

    it('When a .arb name is in grace period it cannot call setResolver', async () => {
      await expect(
        NameWrapper.setResolver(wrappedTokenId, EMPTY_ADDRESS),
      ).to.be.revertedWith(`Unauthorised("${wrappedTokenId}", "${account}")`)
    })

    it('When a .arb name is in grace period it cannot call setTTL', async () => {
      await expect(NameWrapper.setTTL(wrappedTokenId, 0)).to.be.revertedWith(
        `Unauthorised("${wrappedTokenId}", "${account}")`,
      )
    })

    it('When a .arb name is in grace period it cannot call setFuses', async () => {
      await expect(NameWrapper.setFuses(wrappedTokenId, 0)).to.be.revertedWith(
        `Unauthorised("${wrappedTokenId}", "${account}")`,
      )
    })

    it('When a .arb name is in grace period it cannot call setChildFuses', async () => {
      await expect(
        NameWrapper.setChildFuses(wrappedTokenId, labelhash('sub'), 0, 0),
      ).to.be.revertedWith(`Unauthorised("${subTokenId}", "${account}")`)
    })

    it('When a .arb name is in grace period, unexpired subdomains can call setFuses', async () => {
      await NameWrapper2.setFuses(subTokenId, CANNOT_UNWRAP)
      const [, fuses] = await NameWrapper.getData(subTokenId)
      expect(fuses).to.equal(PARENT_CANNOT_CONTROL | CANNOT_UNWRAP)
    })

    it('When a .arb name is in grace period, unexpired subdomains can transfer', async () => {
      await NameWrapper2.safeTransferFrom(
        account2,
        account,
        subTokenId,
        1,
        '0x',
      )
      expect(await NameWrapper.ownerOf(subTokenId)).to.equal(account)
    })

    it('When a .arb name is in grace period, unexpired subdomains can set resolver', async () => {
      await NameWrapper2.setResolver(subTokenId, account)
      expect(await EnsRegistry.resolver(subTokenId)).to.equal(account)
    })

    it('When a .arb name is in grace period, unexpired subdomains can set ttl', async () => {
      await NameWrapper2.setTTL(subTokenId, 100)
      expect(await EnsRegistry.ttl(subTokenId)).to.equal(100)
    })

    it('When a .arb name is in grace period, unexpired subdomains can call setRecord', async () => {
      await NameWrapper2.setRecord(subTokenId, account, account2, 100)
      expect(await NameWrapper.ownerOf(subTokenId)).to.equal(account)
      expect(await EnsRegistry.owner(subTokenId)).to.equal(NameWrapper.address)
      expect(await EnsRegistry.resolver(subTokenId)).to.equal(account2)
      expect(await EnsRegistry.ttl(subTokenId)).to.equal(100)
    })

    it('When a .arb name is in grace period, unexpired subdomains can call setSubnodeOwner', async () => {
      await NameWrapper2.setSubnodeOwner(subTokenId, 'sub2', account2, 0, 0)
      expect(await NameWrapper.ownerOf(namehash('sub2.sub.test.arb'))).to.equal(
        account2,
      )
    })

    it('When a .arb name is in grace period, unexpired subdomains can call setSubnodeRecord', async () => {
      await NameWrapper2.setSubnodeRecord(
        subTokenId,
        'sub2',
        account2,
        EMPTY_ADDRESS,
        0,
        0,
        0,
      )
      expect(await NameWrapper.ownerOf(namehash('sub2.sub.test.arb'))).to.equal(
        account2,
      )
    })

    it('When a .arb name is in grace period, unexpired subdomains can call setChildFuses', async () => {
      await NameWrapper2.setChildFuses(subTokenId, labelhash('sub2'), 0, 100)
      const [, fuses, expiry] = await NameWrapper.getData(
        namehash('sub2.sub.test.arb'),
      )
      expect(expiry).to.equal(100)
      expect(fuses).to.equal(0)
    })
  })

  describe('ERC1155 additional tests', () => {
    const label = 'erc1155'
    const labelHash = labelhash
    const wrappedTokenId = namehash(`${label}.arb`)

    it('Transferring a token that is not owned by the owner reverts', async () => {
      await registerSetupAndWrapName(label, account, CANNOT_UNWRAP)
      await expect(
        NameWrapperH.safeTransferFrom(hacker, account, wrappedTokenId, 1, '0x'),
      ).to.be.revertedWith(`ERC1155: insufficient balance for transfer`)
    })

    it('Approval on the Wrapper does not give permission to wrap the .arb name', async () => {
      await BaseRegistrar.register(labelhash(label), account, 1 * DAY)
      await NameWrapper.setApprovalForAll(hacker, true)
      await expect(
        NameWrapperH.wrapETH2LD(label, hacker, 0, EMPTY_ADDRESS),
      ).to.be.revertedWith(`Unauthorised("${wrappedTokenId}", "${hacker}")`)
    })

    it('Approval on the Wrapper does not give permission to wrap a non .arb name', async () => {
      expect(await EnsRegistry.owner(namehash('xyz'))).to.equal(account)
      await NameWrapper.setApprovalForAll(hacker, true)
      await EnsRegistry.setApprovalForAll(NameWrapper.address, true)
      await expect(
        NameWrapperH.wrap(encodeName('xyz'), hacker, EMPTY_ADDRESS),
      ).to.be.revertedWith(`Unauthorised("${namehash('xyz')}", "${hacker}")`)
    })

    it('When .arb name expires, it is untransferrable', async () => {
      await BaseRegistrar.register(labelhash(label), account, 1 * DAY)
      await NameWrapper.wrapETH2LD(label, account, 0, EMPTY_ADDRESS)

      await evm.advanceTime(GRACE_PERIOD + 1 * DAY + 1)
      await mine()

      await expect(
        NameWrapper.safeTransferFrom(
          account,
          account2,
          wrappedTokenId,
          1,
          '0x',
        ),
      ).to.be.revertedWith('ERC1155: insufficient balance for transfer')
    })

    it('Approval on the Wrapper does not give permission to transfer after expiry', async () => {
      await BaseRegistrar.register(labelhash(label), account, 1 * DAY)
      await NameWrapper.wrapETH2LD(label, account, 0, EMPTY_ADDRESS)
      await NameWrapper.setApprovalForAll(hacker, true)

      await evm.advanceTime(GRACE_PERIOD + 1 * DAY + 1)
      await mine()

      await expect(
        NameWrapper.safeTransferFrom(
          account,
          account2,
          wrappedTokenId,
          1,
          '0x',
        ),
      ).to.be.revertedWith('ERC1155: insufficient balance for transfer')

      await expect(
        NameWrapperH.safeTransferFrom(account, hacker, wrappedTokenId, 1, '0x'),
      ).to.be.revertedWith('ERC1155: insufficient balance for transfer')
    })

    it('When emancipated names expire, they are untransferrible', async () => {
      await BaseRegistrar.register(labelhash(label), account, 86400)
      await NameWrapper.wrapETH2LD(label, account, CANNOT_UNWRAP, EMPTY_ADDRESS)
      await NameWrapper.setSubnodeOwner(
        wrappedTokenId,
        'test',
        account,
        PARENT_CANNOT_CONTROL,
        3600 + (await ethers.provider.getBlock('latest')).timestamp,
      )

      await evm.advanceTime(3601)
      await mine()

      await expect(
        NameWrapper.safeTransferFrom(
          account,
          account2,
          namehash(`test.${label}.arb`),
          1,
          '0x',
        ),
      ).to.be.revertedWith('ERC1155: insufficient balance for transfer')
    })

    it('Returns a balance of 0 for expired names', async () => {
      await BaseRegistrar.register(labelhash(label), account, 86400)
      await NameWrapper.wrapETH2LD(label, account, 0, EMPTY_ADDRESS)

      expect(await NameWrapper.balanceOf(account, wrappedTokenId)).to.equal(1)

      await evm.advanceTime(86401 + GRACE_PERIOD)
      await evm.mine()

      expect(await NameWrapper.balanceOf(account, wrappedTokenId)).to.equal(0)
    })

    it('Reregistering an expired name does not inherit its previous parent fuses', async () => {
      await BaseRegistrar.register(labelhash(label), account, 86400)
      await NameWrapper.wrapETH2LD(label, account, CANNOT_UNWRAP, EMPTY_ADDRESS)

      // Mint the subdomain
      await NameWrapper.setSubnodeOwner(
        wrappedTokenId,
        'test',
        account,
        PARENT_CANNOT_CONTROL,
        3600 + (await ethers.provider.getBlock('latest')).timestamp,
      )

      // Let it expire
      await evm.advanceTime(3601)
      await mine()

      // Mint it again, without PCC
      await NameWrapper.setSubnodeOwner(
        wrappedTokenId,
        'test',
        account,
        0,
        3600 + (await ethers.provider.getBlock('latest')).timestamp,
      )

      // Check PCC isn't set
      const [owner, fuses, expiry] = await NameWrapper.getData(
        namehash(`test.${label}.arb`),
      )
      expect(fuses).to.equal(0)
    })
  })
})
