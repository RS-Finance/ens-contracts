//SPDX-License-Identifier: MIT
pragma solidity ~0.8.17;

import {ERC1155Fuse, IERC165} from "./ERC1155Fuse.sol";
import {Controllable} from "./Controllable.sol";
import {INameWrapper, CANNOT_UNWRAP, CANNOT_BURN_FUSES, CANNOT_TRANSFER, CANNOT_SET_RESOLVER, CANNOT_SET_TTL, CANNOT_CREATE_SUBDOMAIN, PARENT_CANNOT_CONTROL, CAN_DO_EVERYTHING, IS_DOT_ETH, PARENT_CONTROLLED_FUSES, USER_SETTABLE_FUSES} from "./INameWrapper.sol";
import {INameWrapperUpgrade} from "./INameWrapperUpgrade.sol";
import {IMetadataService} from "./IMetadataService.sol";
import {ENS} from "../registry/ENS.sol";
import {IBaseRegistrar} from "../ethregistrar/IBaseRegistrar.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {BytesUtils} from "./BytesUtils.sol";
import {ERC20Recoverable} from "../utils/ERC20Recoverable.sol";

error Unauthorised(bytes32 node, address addr);
error IncompatibleParent();
error IncorrectTokenType();
error LabelMismatch(bytes32 labelHash, bytes32 expectedLabelhash);
error LabelTooShort();
error LabelTooLong(string label);
error IncorrectTargetOwner(address owner);
error CannotUpgrade();
error OperationProhibited(bytes32 node);

contract NameWrapper is
    Ownable,
    ERC1155Fuse,
    INameWrapper,
    Controllable,
    IERC721Receiver,
    ERC20Recoverable
{
    using BytesUtils for bytes;

    ENS public immutable override ens;
    IBaseRegistrar public immutable override registrar;
    IMetadataService public override metadataService;
    mapping(bytes32 => bytes) public override names;
    string public constant name = "NameWrapper";

    uint64 private constant GRACE_PERIOD = 90 days;
    bytes32 private constant ETH_NODE =
        0xd924c6d6935f3bf84be3da0b40fabe48800690c760c2db576028a389f1b54f89;
    bytes32 private constant ETH_LABELHASH =
        0x92d88c52ad061766841fb10033c75b6f62aab72c8fa9086729e0d2f7c7c7621b;
    bytes32 private constant ROOT_NODE =
        0x0000000000000000000000000000000000000000000000000000000000000000;

    INameWrapperUpgrade public upgradeContract;
    uint64 private constant MAX_EXPIRY = type(uint64).max;

    constructor(
        ENS _ens,
        IBaseRegistrar _registrar,
        IMetadataService _metadataService
    ) {
        ens = _ens;
        registrar = _registrar;
        metadataService = _metadataService;

        /* Burn PARENT_CANNOT_CONTROL and CANNOT_UNWRAP fuses for ROOT_NODE and ETH_NODE */

        _setData(
            uint256(ETH_NODE),
            address(0),
            uint32(PARENT_CANNOT_CONTROL | CANNOT_UNWRAP),
            MAX_EXPIRY
        );
        _setData(
            uint256(ROOT_NODE),
            address(0),
            uint32(PARENT_CANNOT_CONTROL | CANNOT_UNWRAP),
            MAX_EXPIRY
        );
        names[ROOT_NODE] = "\x00";
        names[ETH_NODE] = "\x03arb\x00";
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        virtual
        override(ERC1155Fuse, IERC165)
        returns (bool)
    {
        return
            interfaceId == type(INameWrapper).interfaceId ||
            interfaceId == type(IERC721Receiver).interfaceId ||
            super.supportsInterface(interfaceId);
    }

    /* ERC1155 Fuse */

    /**
     * @notice Gets the owner of a name
     * @param id Label as a string of the .arb domain to wrap
     * @return owner The owner of the name
     */

    function ownerOf(uint256 id)
        public
        view
        override(ERC1155Fuse, INameWrapper)
        returns (address owner)
    {
        return super.ownerOf(id);
    }

    /**
     * @notice Gets the data for a name
     * @param id Namehash of the name
     * @return owner Owner of the name
     * @return fuses Fuses of the name
     * @return expiry Expiry of the name
     */

    function getData(uint256 id)
        public
        view
        override(ERC1155Fuse, INameWrapper)
        returns (
            address owner,
            uint32 fuses,
            uint64 expiry
        )
    {
        (owner, fuses, expiry) = super.getData(id);

        bytes32 labelhash = _getEthLabelhash(bytes32(id), fuses);
        if (labelhash != bytes32(0)) {
            expiry = uint64(registrar.nameExpires(uint256(labelhash))) + GRACE_PERIOD;
        }

        if (expiry < block.timestamp) {
            if (fuses & PARENT_CANNOT_CONTROL == PARENT_CANNOT_CONTROL) {
                owner = address(0);
            }
            fuses = 0;
        }
    }

    /* Metadata service */

    /**
     * @notice Set the metadata service. Only the owner can do this
     * @param _metadataService The new metadata service
     */

    function setMetadataService(IMetadataService _metadataService)
        public
        onlyOwner
    {
        metadataService = _metadataService;
    }

    /**
     * @notice Get the metadata uri
     * @param tokenId The id of the token
     * @return string uri of the metadata service
     */

    function uri(uint256 tokenId) public view override returns (string memory) {
        return metadataService.uri(tokenId);
    }

    /**
     * @notice Set the address of the upgradeContract of the contract. only admin can do this
     * @dev The default value of upgradeContract is the 0 address. Use the 0 address at any time
     * to make the contract not upgradable.
     * @param _upgradeAddress address of an upgraded contract
     */

    function setUpgradeContract(INameWrapperUpgrade _upgradeAddress)
        public
        onlyOwner
    {
        if (address(upgradeContract) != address(0)) {
            registrar.setApprovalForAll(address(upgradeContract), false);
            ens.setApprovalForAll(address(upgradeContract), false);
        }

        upgradeContract = _upgradeAddress;

        if (address(upgradeContract) != address(0)) {
            registrar.setApprovalForAll(address(upgradeContract), true);
            ens.setApprovalForAll(address(upgradeContract), true);
        }
    }

    /**
     * @notice Checks if msg.sender is the owner or approved by the owner of a name
     * @param node namehash of the name to check
     */

    modifier onlyTokenOwner(bytes32 node) {
        if (!canModifyName(node, msg.sender)) {
            revert Unauthorised(node, msg.sender);
        }

        _;
    }

    /**
     * @notice Checks if owner or approved by owner
     * @param node namehash of the name to check
     * @param addr which address to check permissions for
     * @return whether or not is owner or approved
     */

    function canModifyName(bytes32 node, address addr)
        public
        view
        override
        returns (bool)
    {
        (address owner, uint32 fuses, uint64 expiry) = getData(uint256(node));
        return (owner == addr || isApprovedForAll(owner, addr)) && (fuses & IS_DOT_ETH == 0 || expiry - GRACE_PERIOD >= block.timestamp);
    }

    /**
     * @notice Wraps a .arb domain, creating a new token and sending the original ERC721 token to this contract
     * @dev Can be called by the owner of the name on the .arb registrar or an authorised caller on the registrar
     * @param label Label as a string of the .arb domain to wrap
     * @param wrappedOwner Owner of the name in this contract
     * @param ownerControlledFuses Initial owner-controlled fuses to set
     * @param resolver Resolver contract address
     */

    function wrapETH2LD(
        string calldata label,
        address wrappedOwner,
        uint16 ownerControlledFuses,
        address resolver
    ) public override {
        uint256 tokenId = uint256(keccak256(bytes(label)));
        address registrant = registrar.ownerOf(tokenId);
        if (
            registrant != msg.sender &&
            !registrar.isApprovedForAll(registrant, msg.sender)
        ) {
            revert Unauthorised(
                _makeNode(ETH_NODE, bytes32(tokenId)),
                msg.sender
            );
        }

        // transfer the token from the user to this contract
        registrar.transferFrom(registrant, address(this), tokenId);

        // transfer the ens record back to the new owner (this contract)
        registrar.reclaim(tokenId, address(this));

        _wrapETH2LD(label, wrappedOwner, ownerControlledFuses, resolver);
    }

    /**
     * @dev Registers a new .arb second-level domain and wraps it.
     *      Only callable by authorised controllers.
     * @param label The label to register (Eg, 'foo' for 'foo.arb').
     * @param wrappedOwner The owner of the wrapped name.
     * @param duration The duration, in seconds, to register the name for.
     * @param resolver The resolver address to set on the ENS registry (optional).
     * @param ownerControlledFuses Initial owner-controlled fuses to set
     * @return registrarExpiry The expiry date of the new name on the .arb registrar, in seconds since the Unix epoch.
     */

    function registerAndWrapETH2LD(
        string calldata label,
        address wrappedOwner,
        uint256 duration,
        address resolver,
        uint16 ownerControlledFuses
    ) external override onlyController returns (uint256 registrarExpiry) {
        uint256 tokenId = uint256(keccak256(bytes(label)));
        registrarExpiry = registrar.register(tokenId, address(this), duration);
        _wrapETH2LD(label, wrappedOwner, ownerControlledFuses, resolver);
    }

    /**
     * @notice Renews a .arb second-level domain.
     * @dev Only callable by authorised controllers.
     * @param tokenId The hash of the label to register (eg, `keccak256('foo')`, for 'foo.arb').
     * @param duration The number of seconds to renew the name for.
     * @return expires The expiry date of the name on the .arb registrar, in seconds since the Unix epoch.
     */

    function renew(
        uint256 tokenId,
        uint256 duration
    ) external override onlyController returns (uint256 expires) {
        return registrar.renew(tokenId, duration);
    }

    /**
     * @notice Wraps a non .arb domain, of any kind. Could be a DNSSEC name vitalik.xyz or a subdomain
     * @dev Can be called by the owner in the registry or an authorised caller in the registry
     * @param name The name to wrap, in DNS format
     * @param wrappedOwner Owner of the name in this contract
     * @param resolver Resolver contract
     */

    function wrap(
        bytes calldata name,
        address wrappedOwner,
        address resolver
    ) public override {
        (bytes32 labelhash, uint256 offset) = name.readLabel(0);
        bytes32 parentNode = name.namehash(offset);
        bytes32 node = _makeNode(parentNode, labelhash);

        names[node] = name;

        if (parentNode == ETH_NODE) {
            revert IncompatibleParent();
        }

        address owner = ens.owner(node);

        if (owner != msg.sender && !ens.isApprovedForAll(owner, msg.sender)) {
            revert Unauthorised(node, msg.sender);
        }

        if (resolver != address(0)) {
            ens.setResolver(node, resolver);
        }

        ens.setOwner(node, address(this));

        _wrap(node, name, wrappedOwner, 0, 0);
    }

    /**
     * @notice Unwraps a .arb domain. e.g. vitalik.arb
     * @dev Can be called by the owner in the wrapper or an authorised caller in the wrapper
     * @param labelhash Labelhash of the .arb domain
     * @param registrant Sets the owner in the .arb registrar to this address
     * @param controller Sets the owner in the registry to this address
     */

    function unwrapETH2LD(
        bytes32 labelhash,
        address registrant,
        address controller
    ) public override onlyTokenOwner(_makeNode(ETH_NODE, labelhash)) {
        if (registrant == address(this)) {
            revert IncorrectTargetOwner(registrant);
        }
        _unwrap(_makeNode(ETH_NODE, labelhash), controller);
        registrar.safeTransferFrom(
            address(this),
            registrant,
            uint256(labelhash)
        );
    }

    /**
     * @notice Unwraps a non .arb domain, of any kind. Could be a DNSSEC name vitalik.xyz or a subdomain
     * @dev Can be called by the owner in the wrapper or an authorised caller in the wrapper
     * @param parentNode Parent namehash of the name e.g. vitalik.xyz would be namehash('xyz')
     * @param labelhash Labelhash of the name, e.g. vitalik.xyz would be keccak256('vitalik')
     * @param controller Sets the owner in the registry to this address
     */

    function unwrap(
        bytes32 parentNode,
        bytes32 labelhash,
        address controller
    ) public override onlyTokenOwner(_makeNode(parentNode, labelhash)) {
        if (parentNode == ETH_NODE) {
            revert IncompatibleParent();
        }
        if (controller == address(0x0) || controller == address(this)) {
            revert IncorrectTargetOwner(controller);
        }
        _unwrap(_makeNode(parentNode, labelhash), controller);
    }

    /**
     * @notice Sets fuses of a name
     * @param node Namehash of the name
     * @param ownerControlledFuses Owner-controlled fuses to burn
     * @return New fuses
     */

    function setFuses(bytes32 node, uint16 ownerControlledFuses)
        public
        onlyTokenOwner(node)
        operationAllowed(node, CANNOT_BURN_FUSES)
        returns (uint32)
    {
        // owner protected by onlyTokenOwner
        (address owner, uint32 oldFuses, uint64 expiry) = getData(
            uint256(node)
        );
        _setFuses(node, owner, ownerControlledFuses | oldFuses, expiry);
        return ownerControlledFuses;
    }

    /**
     * @notice Upgrades a .arb wrapped domain by calling the wrapETH2LD function of the upgradeContract
     *     and burning the token of this contract
     * @dev Can be called by the owner of the name in this contract
     * @param label Label as a string of the .arb name to upgrade
     * @param wrappedOwner The owner of the wrapped name
     */

    function upgradeETH2LD(
        string calldata label,
        address wrappedOwner,
        address resolver
    ) public {
        bytes32 labelhash = keccak256(bytes(label));
        bytes32 node = _makeNode(ETH_NODE, labelhash);
        (uint32 fuses, uint64 expiry) = _prepareUpgrade(node);

        upgradeContract.wrapETH2LD(
            label,
            wrappedOwner,
            fuses,
            expiry,
            resolver
        );
    }

    /**
     * @notice Upgrades a non .arb domain of any kind. Could be a DNSSEC name vitalik.xyz or a subdomain
     * @dev Can be called by the owner or an authorised caller
     * Requires upgraded Namewrapper to permit old Namewrapper to call `setSubnodeRecord` for all names
     * @param parentNode Namehash of the parent name
     * @param label Label as a string of the name to upgrade
     * @param wrappedOwner Owner of the name in this contract
     * @param resolver Resolver contract for this name
     */

    function upgrade(
        bytes32 parentNode,
        string calldata label,
        address wrappedOwner,
        address resolver
    ) public {
        bytes32 labelhash = keccak256(bytes(label));
        bytes32 node = _makeNode(parentNode, labelhash);
        (uint32 fuses, uint64 expiry) = _prepareUpgrade(node);
        upgradeContract.setSubnodeRecord(
            parentNode,
            label,
            wrappedOwner,
            resolver,
            0,
            fuses,
            expiry
        );
    }

    /**
    /* @notice Sets fuses of a name that you own the parent of. Can also be called by the owner of a .arb name
     * @param parentNode Parent namehash of the name e.g. vitalik.xyz would be namehash('xyz')
     * @param labelhash Labelhash of the name, e.g. vitalik.xyz would be keccak256('vitalik')
     * @param fuses Fuses to burn
     * @param expiry When the name will expire in seconds since the Unix epoch
     */

    function setChildFuses(
        bytes32 parentNode,
        bytes32 labelhash,
        uint32 fuses,
        uint64 expiry
    ) public {
        bytes32 node = _makeNode(parentNode, labelhash);
        _checkFusesAreSettable(node, fuses);
        (address owner, uint32 oldFuses, uint64 oldExpiry) = getData(uint256(node));
        // max expiry is set to the expiry of the parent
        (, uint32 parentFuses, uint64 maxExpiry) = getData(
            uint256(parentNode)
        );
        if (parentNode == ROOT_NODE) {
            if (!canModifyName(node, msg.sender)) {
                revert Unauthorised(node, msg.sender);
            }
        } else {
            if (!canModifyName(parentNode, msg.sender)) {
                revert Unauthorised(node, msg.sender);
            }
        }

        _checkParentFuses(node, fuses, parentFuses);

        expiry = _normaliseExpiry(expiry, oldExpiry, maxExpiry);

        // if PARENT_CANNOT_CONTROL has been burned and fuses have changed
        if (
            oldFuses & PARENT_CANNOT_CONTROL != 0 &&
            oldFuses | fuses != oldFuses
        ) {
            revert OperationProhibited(node);
        }
        fuses |= oldFuses;
        _setFuses(node, owner, fuses, expiry);
    }

    /**
     * @notice Sets the subdomain owner in the registry and then wraps the subdomain
     * @param parentNode Parent namehash of the subdomain
     * @param label Label of the subdomain as a string
     * @param owner New owner in the wrapper
     * @param fuses Initial fuses for the wrapped subdomain
     * @param expiry When the name will expire in seconds since the Unix epoch
     * @return node Namehash of the subdomain
     */

    function setSubnodeOwner(
        bytes32 parentNode,
        string calldata label,
        address owner,
        uint32 fuses,
        uint64 expiry
    )
        public
        onlyTokenOwner(parentNode)
        canCallSetSubnodeOwner(parentNode, keccak256(bytes(label)))
        returns (bytes32 node)
    {
        bytes32 labelhash = keccak256(bytes(label));
        node = _makeNode(parentNode, labelhash);
        _checkFusesAreSettable(node, fuses);
        bytes memory name = _saveLabel(parentNode, node, label);
        expiry = _checkParentFusesAndExpiry(parentNode, node, fuses, expiry);

        if (ownerOf(uint256(node)) == address(0)) {
            ens.setSubnodeOwner(parentNode, labelhash, address(this));
            _wrap(node, name, owner, fuses, expiry);
        } else {
            _updateName(parentNode, node, label, owner, fuses, expiry);
        }
    }

    /**
     * @notice Sets the subdomain owner in the registry with records and then wraps the subdomain
     * @param parentNode parent namehash of the subdomain
     * @param label label of the subdomain as a string
     * @param owner new owner in the wrapper
     * @param resolver resolver contract in the registry
     * @param ttl ttl in the regsitry
     * @param fuses initial fuses for the wrapped subdomain
     * @param expiry When the name will expire in seconds since the Unix epoch
     * @return node Namehash of the subdomain
     */

    function setSubnodeRecord(
        bytes32 parentNode,
        string memory label,
        address owner,
        address resolver,
        uint64 ttl,
        uint32 fuses,
        uint64 expiry
    )
        public
        onlyTokenOwner(parentNode)
        canCallSetSubnodeOwner(parentNode, keccak256(bytes(label)))
        returns (bytes32 node)
    {
        bytes32 labelhash = keccak256(bytes(label));
        node = _makeNode(parentNode, labelhash);
        _checkFusesAreSettable(node, fuses);
        _saveLabel(parentNode, node, label);
        expiry = _checkParentFusesAndExpiry(parentNode, node, fuses, expiry);
        if (ownerOf(uint256(node)) == address(0)) {
            ens.setSubnodeRecord(
                parentNode,
                labelhash,
                address(this),
                resolver,
                ttl
            );
            _storeNameAndWrap(parentNode, node, label, owner, fuses, expiry);
        } else {
            ens.setSubnodeRecord(
                parentNode,
                labelhash,
                address(this),
                resolver,
                ttl
            );
            _updateName(parentNode, node, label, owner, fuses, expiry);
        }
    }

    /**
     * @notice Sets records for the name in the ENS Registry
     * @param node Namehash of the name to set a record for
     * @param owner New owner in the registry
     * @param resolver Resolver contract
     * @param ttl Time to live in the registry
     */

    function setRecord(
        bytes32 node,
        address owner,
        address resolver,
        uint64 ttl
    )
        public
        override
        onlyTokenOwner(node)
        operationAllowed(
            node,
            CANNOT_TRANSFER | CANNOT_SET_RESOLVER | CANNOT_SET_TTL
        )
    {
        ens.setRecord(node, address(this), resolver, ttl);
        if (owner == address(0)) {
            (, uint32 fuses, ) = getData(uint256(node));
            if (fuses & IS_DOT_ETH == IS_DOT_ETH) {
                revert IncorrectTargetOwner(owner);
            }
            _unwrap(node, address(0));
        } else {
            address oldOwner = ownerOf(uint256(node));
            _transfer(oldOwner, owner, uint256(node), 1, "");
        }
    }

    /**
     * @notice Sets resolver contract in the registry
     * @param node namehash of the name
     * @param resolver the resolver contract
     */

    function setResolver(bytes32 node, address resolver)
        public
        override
        onlyTokenOwner(node)
        operationAllowed(node, CANNOT_SET_RESOLVER)
    {
        ens.setResolver(node, resolver);
    }

    /**
     * @notice Sets TTL in the registry
     * @param node Namehash of the name
     * @param ttl TTL in the registry
     */

    function setTTL(bytes32 node, uint64 ttl)
        public
        override
        onlyTokenOwner(node)
        operationAllowed(node, CANNOT_SET_TTL)
    {
        ens.setTTL(node, ttl);
    }

    /**
     * @dev Allows an operation only if none of the specified fuses are burned.
     * @param node The namehash of the name to check fuses on.
     * @param fuseMask A bitmask of fuses that must not be burned.
     */

    modifier operationAllowed(bytes32 node, uint32 fuseMask) {
        (, uint32 fuses, ) = getData(uint256(node));
        if (fuses & fuseMask != 0) {
            revert OperationProhibited(node);
        }
        _;
    }

    /**
     * @notice Check whether a name can call setSubnodeOwner/setSubnodeRecord
     * @dev Checks both CANNOT_CREATE_SUBDOMAIN and PARENT_CANNOT_CONTROL and whether not they have been burnt
     *      and checks whether the owner of the subdomain is 0x0 for creating or already exists for
     *      replacing a subdomain. If either conditions are true, then it is possible to call
     *      setSubnodeOwner
     * @param node Namehash of the name to check
     * @param labelhash Labelhash of the name to check
     */

    modifier canCallSetSubnodeOwner(bytes32 node, bytes32 labelhash) {
        bytes32 subnode = _makeNode(node, labelhash);
        address owner = ens.owner(subnode);

        if (owner == address(0)) {
            (, uint32 fuses, ) = getData(uint256(node));
            if (fuses & CANNOT_CREATE_SUBDOMAIN != 0) {
                revert OperationProhibited(subnode);
            }
        } else {
            (, uint32 subnodeFuses, ) = getData(uint256(subnode));
            if (subnodeFuses & PARENT_CANNOT_CONTROL != 0) {
                revert OperationProhibited(subnode);
            }
        }

        _;
    }

    /**
     * @notice Checks all Fuses in the mask are burned for the node
     * @param node Namehash of the name
     * @param fuseMask The fuses you want to check
     * @return Boolean of whether or not all the selected fuses are burned
     */

    function allFusesBurned(bytes32 node, uint32 fuseMask)
        public
        view
        override
        returns (bool)
    {
        (, uint32 fuses, ) = getData(uint256(node));
        return fuses & fuseMask == fuseMask;
    }

    function onERC721Received(
        address to,
        address,
        uint256 tokenId,
        bytes calldata data
    ) public override returns (bytes4) {
        //check if it's the arb registrar ERC721
        if (msg.sender != address(registrar)) {
            revert IncorrectTokenType();
        }

        (
            string memory label,
            address owner,
            uint16 ownerControlledFuses,
            address resolver
        ) = abi.decode(data, (string, address, uint16, address));

        bytes32 labelhash = bytes32(tokenId);
        bytes32 labelhashFromData = keccak256(bytes(label));

        if (labelhashFromData != labelhash) {
            revert LabelMismatch(labelhashFromData, labelhash);
        }

        // transfer the ens record back to the new owner (this contract)
        registrar.reclaim(uint256(labelhash), address(this));

        _wrapETH2LD(label, owner, ownerControlledFuses, resolver);

        return IERC721Receiver(to).onERC721Received.selector;
    }

    /***** Internal functions */

    function _preTransferCheck(uint256 id, uint32 fuses, uint64 expiry) internal view override returns (bool) {
        // For this check, treat .arb 2LDs as expiring at the start of the grace period.
        if(fuses & IS_DOT_ETH == IS_DOT_ETH) {
            expiry -= GRACE_PERIOD;
        }

        if(expiry < block.timestamp) {
            // Transferable if the name was not emancipated
            if(fuses & PARENT_CANNOT_CONTROL != 0) {
                revert("ERC1155: insufficient balance for transfer");
            }
        } else {
            // Transferable if CANNOT_TRANSFER is unburned
            if(fuses & CANNOT_TRANSFER != 0) {
                revert OperationProhibited(bytes32(id));
            }
        }
    }

    function _makeNode(bytes32 node, bytes32 labelhash)
        private
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(node, labelhash));
    }

    function _addLabel(string memory label, bytes memory name)
        internal
        pure
        returns (bytes memory ret)
    {
        if (bytes(label).length < 1) {
            revert LabelTooShort();
        }
        if (bytes(label).length > 255) {
            revert LabelTooLong(label);
        }
        return abi.encodePacked(uint8(bytes(label).length), label, name);
    }

    function _mint(
        bytes32 node,
        address owner,
        uint32 fuses,
        uint64 expiry
    ) internal override {
        _canFusesBeBurned(node, fuses);
        address oldOwner = ownerOf(uint256(node));
        if (oldOwner != address(0)) {
            // burn and unwrap old token of old owner
            _burn(uint256(node));
            emit NameUnwrapped(node, address(0));
        }
        super._mint(node, owner, fuses, expiry);
    }

    function _wrap(
        bytes32 node,
        bytes memory name,
        address wrappedOwner,
        uint32 fuses,
        uint64 expiry
    ) internal {
        _mint(node, wrappedOwner, fuses, expiry);
        emit NameWrapped(node, name, wrappedOwner, fuses, expiry);
    }

    function _storeNameAndWrap(
        bytes32 parentNode,
        bytes32 node,
        string memory label,
        address owner,
        uint32 fuses,
        uint64 expiry
    ) internal {
        bytes memory name = _addLabel(label, names[parentNode]);
        _wrap(node, name, owner, fuses, expiry);
    }

    function _saveLabel(
        bytes32 parentNode,
        bytes32 node,
        string memory label
    ) internal returns (bytes memory) {
        bytes memory name = _addLabel(label, names[parentNode]);
        names[node] = name;
        return name;
    }

    function _prepareUpgrade(bytes32 node)
        private
        returns (uint32 fuses, uint64 expiry)
    {
        if (address(upgradeContract) == address(0)) {
            revert CannotUpgrade();
        }

        if (!canModifyName(node, msg.sender)) {
            revert Unauthorised(node, msg.sender);
        }

        (, fuses, expiry) = getData(uint256(node));

        _burn(uint256(node));
    }

    function _updateName(
        bytes32 parentNode,
        bytes32 node,
        string memory label,
        address owner,
        uint32 fuses,
        uint64 expiry
    ) internal {
        address oldOwner = ownerOf(uint256(node));
        bytes memory name = _addLabel(label, names[parentNode]);
        if (names[node].length == 0) {
            names[node] = name;
        }
        _setFuses(node, oldOwner, fuses, expiry);
        if (owner == address(0)) {
            _unwrap(node, address(0));
        } else {
            _transfer(oldOwner, owner, uint256(node), 1, "");
        }
    }

    // wrapper function for stack limit
    function _checkParentFusesAndExpiry(
        bytes32 parentNode,
        bytes32 node,
        uint32 fuses,
        uint64 expiry
    ) internal view returns (uint64) {
        (, , uint64 oldExpiry) = getData(uint256(node));
        (, uint32 parentFuses, uint64 maxExpiry) = getData(
            uint256(parentNode)
        );
        _checkParentFuses(node, fuses, parentFuses);
        return _normaliseExpiry(expiry, oldExpiry, maxExpiry);
    }

    function _checkParentFuses(
        bytes32 node,
        uint32 fuses,
        uint32 parentFuses
    ) internal pure {
        bool isBurningParentControlledFuses = fuses & PARENT_CONTROLLED_FUSES !=
            0;

        bool parentHasNotBurnedCU = parentFuses & CANNOT_UNWRAP == 0;

        if (isBurningParentControlledFuses && parentHasNotBurnedCU) {
            revert OperationProhibited(node);
        }
    }

    function _normaliseExpiry(
        uint64 expiry,
        uint64 oldExpiry,
        uint64 maxExpiry
    ) internal pure returns (uint64) {
        // Expiry cannot be more than maximum allowed
        // .arb names will check registrar, non .arb check parent
        if (expiry > maxExpiry) {
            expiry = maxExpiry;
        }
        // Expiry cannot be less than old expiry
        if (expiry < oldExpiry) {
            expiry = oldExpiry;
        }

        return expiry;
    }

    function _wrapETH2LD(
        string memory label,
        address wrappedOwner,
        uint16 ownerControlledFuses,
        address resolver
    ) private {
        bytes32 labelhash = keccak256(bytes(label));
        bytes32 node = _makeNode(ETH_NODE, labelhash);
        // hardcode dns-encoded arb string for gas savings
        bytes memory name = _addLabel(label, "\x03arb\x00");
        names[node] = name;

        uint64 expiry = uint64(registrar.nameExpires(uint256(labelhash))) + GRACE_PERIOD;

        _wrap(
            node,
            name,
            wrappedOwner,
            ownerControlledFuses | PARENT_CANNOT_CONTROL | IS_DOT_ETH,
            expiry
        );

        if (resolver != address(0)) {
            ens.setResolver(node, resolver);
        }
    }

    function _unwrap(bytes32 node, address owner) private {
        if (allFusesBurned(node, CANNOT_UNWRAP)) {
            revert OperationProhibited(node);
        }

        // Burn token and fuse data
        _burn(uint256(node));
        ens.setOwner(node, owner);

        emit NameUnwrapped(node, owner);
    }

    function _setFuses(
        bytes32 node,
        address owner,
        uint32 fuses,
        uint64 expiry
    ) internal {
        _setData(node, owner, fuses, expiry);
        emit FusesSet(node, fuses, expiry);
    }

    function _setData(
        bytes32 node,
        address owner,
        uint32 fuses,
        uint64 expiry
    ) internal {
        _canFusesBeBurned(node, fuses);
        super._setData(uint256(node), owner, fuses, expiry);
    }

    function _canFusesBeBurned(bytes32 node, uint32 fuses) internal pure {
        // If a non-parent controlled fuse is being burned, check PCC and CU are burnt
        if (
            fuses & ~PARENT_CONTROLLED_FUSES != 0 &&
            fuses & (PARENT_CANNOT_CONTROL | CANNOT_UNWRAP) !=
            (PARENT_CANNOT_CONTROL | CANNOT_UNWRAP)
        ) {
            revert OperationProhibited(node);
        }
    }

    function _checkFusesAreSettable(bytes32 node, uint32 fuses) internal pure {
        if (fuses | USER_SETTABLE_FUSES != USER_SETTABLE_FUSES) {
            // Cannot directly burn other non-user settable fuses
            revert OperationProhibited(node);
        }
    }

    function _getEthLabelhash(bytes32 node, uint32 fuses)
        internal
        view
        returns (bytes32 labelhash)
    {
        if (fuses & IS_DOT_ETH == IS_DOT_ETH) {
            bytes memory name = names[node];
            (labelhash, ) = name.readLabel(0);
        }
        return labelhash;
    }
}
